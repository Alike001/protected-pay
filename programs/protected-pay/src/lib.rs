use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder, DelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{
    Member, MembersArgs, Permission, ACCOUNT_SIGNATURES_FLAG, AUTHORITY_FLAG, TX_BALANCES_FLAG,
    TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use solana_sha256_hasher::hashv;

declare_id!("w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const PAYMENT_SEED: &[u8] = b"payment";
pub const CRANK_PROBE_SEED: &[u8] = b"crank-probe";
pub const PAYMENT_VERSION: u8 = 2;
pub const PAYMENT_CRANK_INTERVAL_MILLIS: i64 = 60_000;
pub const PAYMENT_CRANK_ITERATIONS: i64 = 6;

#[ephemeral]
#[program]
pub mod protected_pay {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        safety_window_seconds: i64,
        claim_window_seconds: i64,
        private_validator: Pubkey,
    ) -> Result<()> {
        require!(safety_window_seconds > 0, ProtectedPayError::InvalidWindow);
        require!(
            claim_window_seconds > safety_window_seconds,
            ProtectedPayError::InvalidWindow
        );
        require_keys_neq!(
            private_validator,
            Pubkey::default(),
            ProtectedPayError::InvalidValidator
        );

        ctx.accounts.config.set_inner(Config {
            authority: ctx.accounts.authority.key(),
            allowed_mint: ctx.accounts.token_mint.key(),
            token_program: ctx.accounts.token_program.key(),
            safety_window_seconds,
            claim_window_seconds,
            private_validator,
            version: 1,
            bump: ctx.bumps.config,
        });

        Ok(())
    }

    /// Changes policy only for future payments. Every open Payment keeps the
    /// deadlines copied into it, so the authority cannot shorten an active
    /// sender's recovery window.
    pub fn update_timing_policy(
        ctx: Context<UpdateTimingPolicy>,
        safety_window_seconds: i64,
        claim_window_seconds: i64,
    ) -> Result<()> {
        ctx.accounts
            .config
            .update_timing_policy(safety_window_seconds, claim_window_seconds)
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        ctx.accounts.vault.set_inner(Vault {
            token_mint: ctx.accounts.token_mint.key(),
            total_liability: 0,
            bump: ctx.bumps.vault,
        });

        Ok(())
    }

    pub fn initialize_deposit(ctx: Context<InitializeDeposit>) -> Result<()> {
        ctx.accounts.deposit.set_inner(Deposit {
            user: ctx.accounts.user.key(),
            token_mint: ctx.accounts.token_mint.key(),
            available: 0,
            locked: 0,
            next_payment_nonce: 0,
            automation_paused: false,
            version: 1,
        });

        Ok(())
    }

    pub fn create_deposit_permission(ctx: Context<CreateDepositPermission>) -> Result<()> {
        let permission_program = ctx.accounts.permission_program.to_account_info();
        let deposit = ctx.accounts.deposit.to_account_info();
        let permission = ctx.accounts.permission.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();

        let member_flags = AUTHORITY_FLAG
            | TX_LOGS_FLAG
            | TX_BALANCES_FLAG
            | TX_MESSAGE_FLAG
            | ACCOUNT_SIGNATURES_FLAG;
        let members = MembersArgs {
            members: Some(vec![Member {
                flags: member_flags,
                pubkey: ctx.accounts.user.key(),
            }]),
        };

        let user = ctx.accounts.user.key();
        let mint = ctx.accounts.deposit.token_mint;
        let bump = [ctx.bumps.deposit];
        let deposit_seeds: &[&[u8]] = &[DEPOSIT_SEED, user.as_ref(), mint.as_ref(), &bump];

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&deposit)
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(members)
            .invoke_signed(&[deposit_seeds])?;

        Ok(())
    }

    pub fn delegate_deposit_permission(ctx: Context<DelegateDepositPermission>) -> Result<()> {
        let permission_program = ctx.accounts.permission_program.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let user = ctx.accounts.user.to_account_info();
        let deposit = ctx.accounts.deposit.to_account_info();
        let permission = ctx.accounts.permission.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let delegation_buffer = ctx.accounts.delegation_buffer.to_account_info();
        let delegation_record = ctx.accounts.delegation_record.to_account_info();
        let delegation_metadata = ctx.accounts.delegation_metadata.to_account_info();
        let delegation_program = ctx.accounts.delegation_program.to_account_info();
        let validator = ctx.accounts.validator.to_account_info();

        DelegatePermissionCpiBuilder::new(&permission_program)
            .payer(&payer)
            .authority(&user, true)
            .permissioned_account(&deposit, false)
            .permission(&permission)
            .system_program(&system_program)
            .owner_program(&permission_program)
            .delegation_buffer(&delegation_buffer)
            .delegation_record(&delegation_record)
            .delegation_metadata(&delegation_metadata)
            .delegation_program(&delegation_program)
            .validator(Some(&validator))
            .invoke()?;

        Ok(())
    }

    pub fn deposit_usdc(ctx: Context<ModifyBalance>, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);

        // Record the checked accounting first. Solana transaction atomicity rolls
        // it back if the token CPI fails.
        ctx.accounts
            .vault
            .record_deposit(&mut ctx.accounts.deposit, amount)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        Ok(())
    }

    pub fn withdraw_usdc(ctx: Context<ModifyBalance>, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);

        // Record the checked accounting first. Solana transaction atomicity rolls
        // it back if the token CPI fails.
        ctx.accounts
            .vault
            .record_withdrawal(&mut ctx.accounts.deposit, amount)?;

        let mint = ctx.accounts.token_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &bump];
        let signer_seeds = &[vault_seeds];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        Ok(())
    }

    /// Creates a public, amount-free shell before it is permissioned and
    /// delegated. Sender/recipient relationship metadata is deliberately not
    /// part of the privacy claim; amount, memo, live status, and balances are.
    pub fn prepare_payment(
        ctx: Context<PreparePayment>,
        payment_id: [u8; 32],
        recipient: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.sender.key(),
            recipient,
            ProtectedPayError::SameParty
        );
        require_keys_neq!(
            recipient,
            Pubkey::default(),
            ProtectedPayError::InvalidRecipient
        );

        ctx.accounts.payment.set_inner(Payment {
            payment_id,
            sender: ctx.accounts.sender.key(),
            recipient,
            token_mint: ctx.accounts.config.allowed_mint,
            amount: 0,
            created_at: 0,
            settle_after: 0,
            expires_at: 0,
            task_id: 0,
            status: PaymentStatus::Created,
            memo_hash: [0; 32],
            terminal_commitment: [0; 32],
            initialized: false,
            redacted: false,
            version: PAYMENT_VERSION,
            bump: ctx.bumps.payment,
        });
        Ok(())
    }

    pub fn create_payment_permission(ctx: Context<CreatePaymentPermission>) -> Result<()> {
        let permission_program = ctx.accounts.permission_program.to_account_info();
        let payment = ctx.accounts.payment.to_account_info();
        let permission = ctx.accounts.permission.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let member_flags = AUTHORITY_FLAG
            | TX_LOGS_FLAG
            | TX_BALANCES_FLAG
            | TX_MESSAGE_FLAG
            | ACCOUNT_SIGNATURES_FLAG;
        let members = MembersArgs {
            members: Some(vec![
                Member {
                    flags: member_flags,
                    pubkey: ctx.accounts.payment.sender,
                },
                Member {
                    flags: member_flags,
                    pubkey: ctx.accounts.payment.recipient,
                },
            ]),
        };
        let payment_id = ctx.accounts.payment.payment_id;
        let bump = [ctx.accounts.payment.bump];
        let payment_seeds: &[&[u8]] = &[PAYMENT_SEED, payment_id.as_ref(), &bump];

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&payment)
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(members)
            .invoke_signed(&[payment_seeds])?;
        Ok(())
    }

    pub fn delegate_payment_permission(ctx: Context<DelegatePaymentPermission>) -> Result<()> {
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(&ctx.accounts.sender.to_account_info(), true)
            .permissioned_account(&ctx.accounts.payment.to_account_info(), false)
            .permission(&ctx.accounts.permission.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.delegation_buffer.to_account_info())
            .delegation_record(&ctx.accounts.delegation_record.to_account_info())
            .delegation_metadata(&ctx.accounts.delegation_metadata.to_account_info())
            .delegation_program(&ctx.accounts.delegation_program.to_account_info())
            .validator(Some(&ctx.accounts.validator.to_account_info()))
            .invoke()?;
        Ok(())
    }

    pub fn delegate_payment(ctx: Context<DelegatePayment>, payment_id: [u8; 32]) -> Result<()> {
        let data = ctx.accounts.payment.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let payment = Payment::try_deserialize(&mut slice)?;
        require_keys_eq!(
            payment.sender,
            ctx.accounts.sender.key(),
            ProtectedPayError::Unauthorized
        );
        require!(
            payment.payment_id == payment_id && !payment.initialized,
            ProtectedPayError::InvalidPaymentShell
        );
        drop(data);

        ctx.accounts.delegate_payment(
            &ctx.accounts.payer,
            &[PAYMENT_SEED, payment_id.as_ref()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..DelegateConfig::default()
            },
        )?;
        Ok(())
    }

    /// Writes the private terms only after the shell has been delegated.
    pub fn open_payment(
        ctx: Context<OpenPayment>,
        payment_id: [u8; 32],
        amount: u64,
        memo_hash: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.payment.payment_id == payment_id,
            ProtectedPayError::InvalidPaymentShell
        );
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.payment.open(
            &mut ctx.accounts.sender_deposit,
            ctx.accounts.sender.key(),
            amount,
            memo_hash,
            now,
            ctx.accounts.config.safety_window_seconds,
            ctx.accounts.config.claim_window_seconds,
        )
    }

    /// Recipient confirmation never needs access to the sender's Deposit.
    pub fn acknowledge_payment(ctx: Context<AcknowledgePayment>) -> Result<()> {
        ctx.accounts
            .payment
            .acknowledge(ctx.accounts.recipient.key(), Clock::get()?.unix_timestamp)
    }

    pub fn cancel_payment(ctx: Context<CancelPayment>) -> Result<()> {
        ctx.accounts
            .payment
            .cancel(&mut ctx.accounts.sender_deposit, ctx.accounts.sender.key())
    }

    /// Permissionless and signer-free. Crank mutates only the shared Payment;
    /// each entitled party later claims into only their own private Deposit.
    pub fn advance_payment(ctx: Context<AdvancePayment>) -> Result<()> {
        ctx.accounts.payment.advance(Clock::get()?.unix_timestamp)
    }

    pub fn claim_payment(ctx: Context<ClaimPayment>) -> Result<()> {
        ctx.accounts.payment.claim(
            &mut ctx.accounts.claimant_deposit,
            ctx.accounts.claimant.key(),
        )
    }

    /// Registers the same stored, signer-free instruction for repeated Crank
    /// execution. The task cannot supply or change payment terms.
    pub fn schedule_payment<'info>(
        ctx: Context<'info, SchedulePayment<'info>>,
        payment_id: [u8; 32],
        args: SchedulePaymentArgs,
    ) -> Result<()> {
        require!(args.task_id > 0, ProtectedPayError::InvalidCrankSchedule);
        require!(
            args.execution_interval_millis == PAYMENT_CRANK_INTERVAL_MILLIS
                && args.iterations == PAYMENT_CRANK_ITERATIONS,
            ProtectedPayError::InvalidCrankSchedule
        );

        require_keys_eq!(
            *ctx.accounts.payment.owner,
            crate::ID,
            ProtectedPayError::InvalidAccountOwner
        );
        let payment_data = ctx.accounts.payment.try_borrow_data()?;
        let mut payment_slice: &[u8] = &payment_data;
        let mut payment = Payment::try_deserialize(&mut payment_slice)?;
        require!(
            payment.payment_id == payment_id,
            ProtectedPayError::InvalidPaymentShell
        );
        payment.validate_schedule_actor(ctx.accounts.payer.key())?;
        require!(
            payment.task_id == 0,
            ProtectedPayError::TaskAlreadyScheduled
        );
        payment.task_id = args.task_id;
        drop(payment_data);

        let mut payment_data = ctx.accounts.payment.try_borrow_mut_data()?;
        let mut output: &mut [u8] = &mut payment_data;
        payment.try_serialize(&mut output)?;
        drop(payment_data);

        let advance_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.payment.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::AdvancePayment {}),
        };
        let schedule_ix = Instruction::new_with_bincode(
            ctx.accounts.magic_program.key(),
            &MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![advance_ix],
            }),
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.payment.key(), false),
            ],
        );
        invoke(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.payment.to_account_info(),
            ],
        )?;
        Ok(())
    }

    pub fn redact_terminal_payment(ctx: Context<RedactTerminalPayment>) -> Result<()> {
        ctx.accounts.payment.redact()
    }

    pub fn commit_and_undelegate_payment(ctx: Context<CommitAndUndelegatePayment>) -> Result<()> {
        require!(
            ctx.accounts.payment.redacted,
            ProtectedPayError::NotRedacted
        );
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.payment.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Creates the smallest payment-shaped state used to prove that MagicBlock
    /// Crank can advance permissioned, delegated accounts without a user online.
    pub fn initialize_crank_probe(
        ctx: Context<InitializeCrankProbe>,
        delay_seconds: i64,
    ) -> Result<()> {
        require!(
            (1..=60).contains(&delay_seconds),
            ProtectedPayError::InvalidCrankSchedule
        );
        let not_before = Clock::get()?
            .unix_timestamp
            .checked_add(delay_seconds)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        ctx.accounts.crank_probe.set_inner(CrankProbe {
            owner: ctx.accounts.payer.key(),
            deposit: ctx.accounts.deposit.key(),
            not_before,
            task_id: 0,
            transition_count: 0,
            status: CrankProbeStatus::Pending,
            version: 1,
            bump: ctx.bumps.crank_probe,
        });
        Ok(())
    }

    pub fn create_crank_probe_permission(ctx: Context<CreateCrankProbePermission>) -> Result<()> {
        let permission_program = ctx.accounts.permission_program.to_account_info();
        let crank_probe = ctx.accounts.crank_probe.to_account_info();
        let permission = ctx.accounts.permission.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let member_flags = AUTHORITY_FLAG
            | TX_LOGS_FLAG
            | TX_BALANCES_FLAG
            | TX_MESSAGE_FLAG
            | ACCOUNT_SIGNATURES_FLAG;
        let members = MembersArgs {
            members: Some(vec![Member {
                flags: member_flags,
                pubkey: ctx.accounts.owner.key(),
            }]),
        };
        let owner = ctx.accounts.owner.key();
        let bump = [ctx.accounts.crank_probe.bump];
        let probe_seeds: &[&[u8]] = &[CRANK_PROBE_SEED, owner.as_ref(), &bump];

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&crank_probe)
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(members)
            .invoke_signed(&[probe_seeds])?;
        Ok(())
    }

    pub fn delegate_crank_probe_permission(
        ctx: Context<DelegateCrankProbePermission>,
    ) -> Result<()> {
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(&ctx.accounts.owner.to_account_info(), true)
            .permissioned_account(&ctx.accounts.crank_probe.to_account_info(), false)
            .permission(&ctx.accounts.permission.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.delegation_buffer.to_account_info())
            .delegation_record(&ctx.accounts.delegation_record.to_account_info())
            .delegation_metadata(&ctx.accounts.delegation_metadata.to_account_info())
            .delegation_program(&ctx.accounts.delegation_program.to_account_info())
            .validator(Some(&ctx.accounts.validator.to_account_info()))
            .invoke()?;
        Ok(())
    }

    pub fn delegate_crank_probe(
        ctx: Context<DelegateCrankProbe>,
        probe_owner: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            probe_owner,
            ProtectedPayError::Unauthorized
        );
        ctx.accounts.delegate_crank_probe(
            &ctx.accounts.payer,
            &[CRANK_PROBE_SEED, probe_owner.as_ref()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..DelegateConfig::default()
            },
        )?;
        Ok(())
    }

    /// Stores a fixed, signer-free target instruction in MagicBlock Crank.
    /// The target receives no amount, recipient, or policy input from the cranker.
    pub fn schedule_crank_probe<'info>(
        ctx: Context<'info, ScheduleCrankProbe<'info>>,
        args: ScheduleCrankProbeArgs,
    ) -> Result<()> {
        require!(args.task_id > 0, ProtectedPayError::InvalidCrankSchedule);
        require!(
            (250..=10_000).contains(&args.execution_interval_millis),
            ProtectedPayError::InvalidCrankSchedule
        );
        require!(
            (2..=10).contains(&args.iterations),
            ProtectedPayError::InvalidCrankSchedule
        );

        let advance_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.crank_probe.key(), false),
                AccountMeta::new(ctx.accounts.deposit.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::AdvanceCrankProbe {}),
        };

        // Persist the task identity before invoking the scheduler. Transaction
        // atomicity rolls this write back if scheduling fails.
        let data = ctx.accounts.crank_probe.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let mut probe = CrankProbe::try_deserialize(&mut slice)?;
        require!(
            probe.owner == ctx.accounts.payer.key() && probe.deposit == ctx.accounts.deposit.key(),
            ProtectedPayError::ProbeDepositMismatch
        );
        probe.task_id = args.task_id;
        drop(data);
        let mut data = ctx.accounts.crank_probe.try_borrow_mut_data()?;
        let mut output: &mut [u8] = &mut data;
        probe.try_serialize(&mut output)?;
        drop(data);

        let schedule_ix = Instruction::new_with_bincode(
            ctx.accounts.magic_program.key(),
            &MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![advance_ix],
            }),
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.crank_probe.key(), false),
                AccountMeta::new(ctx.accounts.deposit.key(), false),
            ],
        );
        invoke(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.crank_probe.to_account_info(),
                ctx.accounts.deposit.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// Permissionless by design: correctness depends only on stored account
    /// relationships, status, and the onchain clock. Replays are idempotent.
    pub fn advance_crank_probe(ctx: Context<AdvanceCrankProbe>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts
            .crank_probe
            .advance(&mut ctx.accounts.deposit, now)
    }

    pub fn delegate_deposit(
        ctx: Context<DelegateDeposit>,
        user: Pubkey,
        token_mint: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            user,
            ProtectedPayError::Unauthorized
        );

        ctx.accounts.delegate_deposit(
            &ctx.accounts.payer,
            &[DEPOSIT_SEED, user.as_ref(), token_mint.as_ref()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..DelegateConfig::default()
            },
        )?;

        Ok(())
    }

    pub fn commit_and_undelegate_deposit(ctx: Context<CommitAndUndelegateDeposit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.deposit.to_account_info()])
        .build_and_invoke()?;

        Ok(())
    }

    pub fn commit_and_undelegate_crank_probe(
        ctx: Context<CommitAndUndelegateCrankProbe>,
    ) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.crank_probe.to_account_info(),
            ctx.accounts.deposit.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTimingPolicy<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
        constraint = config.token_program == token_program.key() @ ProtectedPayError::WrongTokenProgram,
        constraint = config.allowed_mint == token_mint.key() @ ProtectedPayError::WrongMint,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeDeposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Anyone may create a zero-balance destination account. The PDA
    /// binds this account to the supplied user, and initialization cannot repeat.
    pub user: UncheckedAccount<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.token_program == token_program.key() @ ProtectedPayError::WrongTokenProgram,
        constraint = config.allowed_mint == token_mint.key() @ ProtectedPayError::WrongMint,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, user.key().as_ref(), token_mint.key().as_ref()],
        bump,
    )]
    pub deposit: Account<'info, Deposit>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateDepositPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub user: Signer<'info>,
    #[account(
        seeds = [DEPOSIT_SEED, user.key().as_ref(), deposit.token_mint.as_ref()],
        bump,
        has_one = user,
    )]
    pub deposit: Account<'info, Deposit>,
    /// CHECK: The address is derived and validated against the Permission Program.
    #[account(
        mut,
        address = Permission::find_pda(&deposit.key()).0,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegateDepositPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub user: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [DEPOSIT_SEED, user.key().as_ref(), deposit.token_mint.as_ref()],
        bump,
        has_one = user,
    )]
    pub deposit: Account<'info, Deposit>,
    /// CHECK: Address is derived from the protected Deposit.
    #[account(
        mut,
        address = Permission::find_pda(&deposit.key()).0,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The Permission Program initializes and validates this PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegate_buffer_pda_from_delegated_account_and_owner_program(
            &permission.key(),
            &PERMISSION_PROGRAM_ID,
        ),
    )]
    pub delegation_buffer: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program initializes and validates this PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program initializes and validates this PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_metadata_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Delegation Program ID.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: Fixed by Config so permission and Deposit use the same Private ER.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyBalance<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.token_program == token_program.key() @ ProtectedPayError::WrongTokenProgram,
        constraint = config.allowed_mint == token_mint.key() @ ProtectedPayError::WrongMint,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [VAULT_SEED, token_mint.key().as_ref()],
        bump = vault.bump,
        has_one = token_mint,
        constraint = vault.token_mint == config.allowed_mint @ ProtectedPayError::WrongMint,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, user.key().as_ref(), token_mint.key().as_ref()],
        bump,
        has_one = user,
        has_one = token_mint,
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(address = config.allowed_mint @ ProtectedPayError::WrongMint)]
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32], recipient: Pubkey)]
pub struct PreparePayment<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = sender,
        space = 8 + Payment::INIT_SPACE,
        seeds = [PAYMENT_SEED, payment_id.as_ref()],
        bump,
    )]
    pub payment: Account<'info, Payment>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePaymentPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sender: Signer<'info>,
    #[account(
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
        constraint = !payment.initialized @ ProtectedPayError::PaymentAlreadyOpen,
    )]
    pub payment: Account<'info, Payment>,
    /// CHECK: Address is derived from the protected Payment.
    #[account(mut, address = Permission::find_pda(&payment.key()).0)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegatePaymentPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sender: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
        constraint = !payment.initialized @ ProtectedPayError::PaymentAlreadyOpen,
    )]
    pub payment: Account<'info, Payment>,
    /// CHECK: Address is derived from the protected Payment.
    #[account(mut, address = Permission::find_pda(&payment.key()).0)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The Permission Program validates this delegation buffer PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegate_buffer_pda_from_delegated_account_and_owner_program(
            &permission.key(),
            &PERMISSION_PROGRAM_ID,
        ),
    )]
    pub delegation_buffer: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program validates this record PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program validates this metadata PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_metadata_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Delegation Program ID.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: Fixed by Config so all protected accounts use the same Private ER.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct DelegatePayment<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sender: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Fixed by Config to the selected Private ER validator.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    /// CHECK: The handler deserializes this account and verifies shell authority;
    /// the delegate macro validates the PDA and owner before its CPI.
    #[account(
        mut,
        del,
        seeds = [PAYMENT_SEED, payment_id.as_ref()],
        bump,
    )]
    pub payment: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct OpenPayment<'info> {
    pub sender: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.payment_id == payment_id @ ProtectedPayError::InvalidPaymentShell,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
        constraint = payment.token_mint == config.allowed_mint @ ProtectedPayError::WrongMint,
    )]
    pub payment: Account<'info, Payment>,
    #[account(
        mut,
        seeds = [
            DEPOSIT_SEED,
            sender.key().as_ref(),
            payment.token_mint.as_ref(),
        ],
        bump,
        constraint = sender_deposit.user == sender.key() @ ProtectedPayError::Unauthorized,
        constraint = sender_deposit.token_mint == payment.token_mint @ ProtectedPayError::WrongMint,
    )]
    pub sender_deposit: Account<'info, Deposit>,
}

#[derive(Accounts)]
pub struct AcknowledgePayment<'info> {
    pub recipient: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.recipient == recipient.key() @ ProtectedPayError::Unauthorized,
    )]
    pub payment: Account<'info, Payment>,
}

#[derive(Accounts)]
pub struct CancelPayment<'info> {
    pub sender: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
    )]
    pub payment: Account<'info, Payment>,
    #[account(
        mut,
        seeds = [
            DEPOSIT_SEED,
            payment.sender.as_ref(),
            payment.token_mint.as_ref(),
        ],
        bump,
        constraint = sender_deposit.user == payment.sender @ ProtectedPayError::PaymentDepositMismatch,
        constraint = sender_deposit.token_mint == payment.token_mint @ ProtectedPayError::WrongMint,
    )]
    pub sender_deposit: Account<'info, Deposit>,
}

#[derive(Accounts)]
pub struct AdvancePayment<'info> {
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,
}

#[derive(Accounts)]
pub struct ClaimPayment<'info> {
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,
    #[account(
        mut,
        seeds = [
            DEPOSIT_SEED,
            claimant.key().as_ref(),
            payment.token_mint.as_ref(),
        ],
        bump,
        constraint = claimant_deposit.user == claimant.key() @ ProtectedPayError::Unauthorized,
        constraint = claimant_deposit.token_mint == payment.token_mint @ ProtectedPayError::WrongMint,
    )]
    pub claimant_deposit: Account<'info, Deposit>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SchedulePaymentArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct SchedulePayment<'info> {
    /// CHECK: Fixed to MagicBlock's scheduling program used by the pinned SDK.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Deserialized and relationship-checked before the scheduler CPI.
    #[account(mut, seeds = [PAYMENT_SEED, payment_id.as_ref()], bump)]
    pub payment: UncheckedAccount<'info>,
    /// CHECK: The scheduled instruction must target this deployed program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RedactTerminalPayment<'info> {
    pub sender: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
    )]
    pub payment: Account<'info, Payment>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegatePayment<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sender: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.payment_id.as_ref()],
        bump = payment.bump,
        constraint = payment.sender == sender.key() @ ProtectedPayError::Unauthorized,
        constraint = payment.redacted @ ProtectedPayError::NotRedacted,
    )]
    pub payment: Account<'info, Payment>,
}

#[derive(Accounts)]
pub struct InitializeCrankProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [DEPOSIT_SEED, payer.key().as_ref(), deposit.token_mint.as_ref()],
        bump,
        constraint = deposit.user == payer.key() @ ProtectedPayError::Unauthorized,
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        init,
        payer = payer,
        space = 8 + CrankProbe::INIT_SPACE,
        seeds = [CRANK_PROBE_SEED, payer.key().as_ref()],
        bump,
    )]
    pub crank_probe: Account<'info, CrankProbe>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateCrankProbePermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(
        seeds = [CRANK_PROBE_SEED, owner.key().as_ref()],
        bump = crank_probe.bump,
        has_one = owner,
    )]
    pub crank_probe: Account<'info, CrankProbe>,
    /// CHECK: Address is derived and validated against the Permission Program.
    #[account(mut, address = Permission::find_pda(&crank_probe.key()).0)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegateCrankProbePermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [CRANK_PROBE_SEED, owner.key().as_ref()],
        bump = crank_probe.bump,
        has_one = owner,
    )]
    pub crank_probe: Account<'info, CrankProbe>,
    /// CHECK: Address is derived from the protected CrankProbe.
    #[account(mut, address = Permission::find_pda(&crank_probe.key()).0)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The Permission Program validates this delegation buffer PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegate_buffer_pda_from_delegated_account_and_owner_program(
            &permission.key(),
            &PERMISSION_PROGRAM_ID,
        ),
    )]
    pub delegation_buffer: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program validates this record PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: The Delegation Program validates this metadata PDA.
    #[account(
        mut,
        address = ephemeral_rollups_sdk::pda::delegation_metadata_pda_from_delegated_account(
            &permission.key(),
        ),
    )]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: Fixed to MagicBlock's Delegation Program ID.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: Fixed by Config so every protected account uses the same Private ER.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(probe_owner: Pubkey)]
pub struct DelegateCrankProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Fixed by Config to the selected Private ER validator.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    /// CHECK: The delegate macro validates the PDA and current owner before CPI.
    #[account(
        mut,
        del,
        seeds = [CRANK_PROBE_SEED, probe_owner.as_ref()],
        bump,
    )]
    pub crank_probe: UncheckedAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ScheduleCrankProbeArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[derive(Accounts)]
pub struct ScheduleCrankProbe<'info> {
    /// CHECK: Fixed to MagicBlock's scheduling program used by the pinned SDK.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Unchecked prevents stale Anchor serialization after the scheduler CPI.
    #[account(mut, seeds = [CRANK_PROBE_SEED, payer.key().as_ref()], bump)]
    pub crank_probe: UncheckedAccount<'info>,
    /// CHECK: Its exact address is matched against the stored CrankProbe link before CPI.
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: The scheduled instruction must target this deployed program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdvanceCrankProbe<'info> {
    #[account(
        mut,
        seeds = [CRANK_PROBE_SEED, crank_probe.owner.as_ref()],
        bump = crank_probe.bump,
        has_one = deposit @ ProtectedPayError::ProbeDepositMismatch,
    )]
    pub crank_probe: Account<'info, CrankProbe>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, crank_probe.owner.as_ref(), deposit.token_mint.as_ref()],
        bump,
        constraint = deposit.user == crank_probe.owner @ ProtectedPayError::ProbeDepositMismatch,
    )]
    pub deposit: Account<'info, Deposit>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(user: Pubkey, token_mint: Pubkey)]
pub struct DelegateDeposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.allowed_mint == token_mint @ ProtectedPayError::WrongMint,
    )]
    pub config: Account<'info, Config>,
    /// CHECK: Fixed by Config so permission and Deposit use the same Private ER.
    #[account(address = config.private_validator @ ProtectedPayError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
    /// CHECK: The delegate macro validates the PDA and ownership before CPI.
    #[account(
        mut,
        del,
        seeds = [DEPOSIT_SEED, user.as_ref(), token_mint.as_ref()],
        bump,
    )]
    pub deposit: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateDeposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, user.key().as_ref(), deposit.token_mint.as_ref()],
        bump,
        has_one = user,
    )]
    pub deposit: Account<'info, Deposit>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateCrankProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CRANK_PROBE_SEED, owner.key().as_ref()],
        bump = crank_probe.bump,
        has_one = owner,
        has_one = deposit @ ProtectedPayError::ProbeDepositMismatch,
    )]
    pub crank_probe: Account<'info, CrankProbe>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, owner.key().as_ref(), deposit.token_mint.as_ref()],
        bump,
        constraint = deposit.user == owner.key() @ ProtectedPayError::ProbeDepositMismatch,
    )]
    pub deposit: Account<'info, Deposit>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub allowed_mint: Pubkey,
    pub token_program: Pubkey,
    pub safety_window_seconds: i64,
    pub claim_window_seconds: i64,
    pub private_validator: Pubkey,
    pub version: u8,
    pub bump: u8,
}

impl Config {
    pub fn update_timing_policy(
        &mut self,
        safety_window_seconds: i64,
        claim_window_seconds: i64,
    ) -> Result<()> {
        require!(safety_window_seconds > 0, ProtectedPayError::InvalidWindow);
        require!(
            claim_window_seconds > safety_window_seconds,
            ProtectedPayError::InvalidWindow
        );
        self.safety_window_seconds = safety_window_seconds;
        self.claim_window_seconds = claim_window_seconds;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub token_mint: Pubkey,
    pub total_liability: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    Created,
    Acknowledged,
    Settled,
    Cancelled,
    Expired,
}

impl PaymentStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Settled | Self::Cancelled | Self::Expired)
    }

    fn commitment_tag(self) -> u8 {
        match self {
            Self::Created => 0,
            Self::Acknowledged => 1,
            Self::Settled => 2,
            Self::Cancelled => 3,
            Self::Expired => 4,
        }
    }
}

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Payment {
    pub payment_id: [u8; 32],
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub created_at: i64,
    pub settle_after: i64,
    pub expires_at: i64,
    pub task_id: i64,
    pub status: PaymentStatus,
    pub memo_hash: [u8; 32],
    pub terminal_commitment: [u8; 32],
    pub initialized: bool,
    pub redacted: bool,
    pub version: u8,
    pub bump: u8,
}

impl Payment {
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        sender_deposit: &mut Deposit,
        actor: Pubkey,
        amount: u64,
        memo_hash: [u8; 32],
        now: i64,
        safety_window_seconds: i64,
        claim_window_seconds: i64,
    ) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(!self.initialized, ProtectedPayError::PaymentAlreadyOpen);
        require!(!self.redacted, ProtectedPayError::InvalidPaymentShell);
        require_keys_eq!(self.sender, actor, ProtectedPayError::Unauthorized);
        require_keys_neq!(self.sender, self.recipient, ProtectedPayError::SameParty);
        self.validate_sender_deposit(sender_deposit)?;
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        require!(
            safety_window_seconds > 0 && claim_window_seconds > safety_window_seconds,
            ProtectedPayError::InvalidWindow
        );

        let settle_after = now
            .checked_add(safety_window_seconds)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        let expires_at = now
            .checked_add(claim_window_seconds)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        let next_payment_nonce = sender_deposit
            .next_payment_nonce
            .checked_add(1)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;

        // The value leaves the sender's aggregate Deposit and becomes the
        // liability represented by this one shared Payment account. This lets
        // Crank mutate only Payment without gaining access to either party's
        // aggregate private balance.
        sender_deposit.debit_available(amount)?;
        sender_deposit.next_payment_nonce = next_payment_nonce;
        self.amount = amount;
        self.created_at = now;
        self.settle_after = settle_after;
        self.expires_at = expires_at;
        self.task_id = 0;
        self.status = PaymentStatus::Created;
        self.memo_hash = memo_hash;
        self.terminal_commitment = [0; 32];
        self.initialized = true;
        Ok(())
    }

    pub fn acknowledge(&mut self, actor: Pubkey, now: i64) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);
        require!(!self.redacted, ProtectedPayError::PaymentRedacted);
        require_keys_eq!(self.recipient, actor, ProtectedPayError::Unauthorized);
        require!(
            self.status == PaymentStatus::Created,
            ProtectedPayError::InvalidPaymentStatus
        );
        require!(now < self.expires_at, ProtectedPayError::PaymentExpired);
        self.status = PaymentStatus::Acknowledged;
        Ok(())
    }

    pub fn cancel(&mut self, sender_deposit: &mut Deposit, actor: Pubkey) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);
        require!(!self.redacted, ProtectedPayError::PaymentRedacted);
        require!(
            !self.status.is_terminal(),
            ProtectedPayError::InvalidPaymentStatus
        );
        require_keys_eq!(self.sender, actor, ProtectedPayError::Unauthorized);
        self.validate_sender_deposit(sender_deposit)?;
        require!(
            matches!(
                self.status,
                PaymentStatus::Created | PaymentStatus::Acknowledged
            ),
            ProtectedPayError::InvalidPaymentStatus
        );

        sender_deposit.credit(self.amount)?;
        self.status = PaymentStatus::Cancelled;
        self.seal_terminal();
        Ok(())
    }

    pub fn advance(&mut self, now: i64) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);

        if self.status.is_terminal() {
            return Ok(());
        }
        require!(!self.redacted, ProtectedPayError::PaymentRedacted);

        match self.status {
            PaymentStatus::Acknowledged if now >= self.settle_after => {
                self.status = PaymentStatus::Settled;
            }
            PaymentStatus::Created if now >= self.expires_at => {
                self.status = PaymentStatus::Expired;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn claim(&mut self, claimant_deposit: &mut Deposit, actor: Pubkey) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);
        require!(!self.redacted, ProtectedPayError::PaymentRedacted);

        let expected_claimant = match self.status {
            PaymentStatus::Settled => self.recipient,
            PaymentStatus::Expired => self.sender,
            _ => return err!(ProtectedPayError::PaymentNotClaimable),
        };
        require_keys_eq!(expected_claimant, actor, ProtectedPayError::Unauthorized);
        self.validate_claimant_deposit(claimant_deposit, actor)?;

        claimant_deposit.credit(self.amount)?;
        self.seal_terminal();
        Ok(())
    }

    pub fn validate_schedule_actor(&self, actor: Pubkey) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);
        require!(!self.redacted, ProtectedPayError::PaymentRedacted);
        require!(
            !self.status.is_terminal(),
            ProtectedPayError::InvalidPaymentStatus
        );
        require_keys_eq!(self.sender, actor, ProtectedPayError::Unauthorized);
        Ok(())
    }

    pub fn redact(&mut self) -> Result<()> {
        require!(
            self.version == PAYMENT_VERSION,
            ProtectedPayError::UnsupportedPaymentVersion
        );
        require!(self.initialized, ProtectedPayError::PaymentNotOpen);
        require!(
            self.status.is_terminal(),
            ProtectedPayError::PaymentNotTerminal
        );
        if self.redacted {
            return Ok(());
        }

        err!(ProtectedPayError::PaymentFundsUnclaimed)
    }

    fn seal_terminal(&mut self) {
        debug_assert!(self.status.is_terminal());
        debug_assert!(!self.redacted);

        let amount = self.amount.to_le_bytes();
        let created_at = self.created_at.to_le_bytes();
        let settle_after = self.settle_after.to_le_bytes();
        let expires_at = self.expires_at.to_le_bytes();
        let status = [self.status.commitment_tag()];
        self.terminal_commitment = hashv(&[
            self.payment_id.as_ref(),
            self.sender.as_ref(),
            self.recipient.as_ref(),
            self.token_mint.as_ref(),
            amount.as_ref(),
            created_at.as_ref(),
            settle_after.as_ref(),
            expires_at.as_ref(),
            status.as_ref(),
            self.memo_hash.as_ref(),
        ])
        .to_bytes();

        self.recipient = Pubkey::default();
        self.amount = 0;
        self.created_at = 0;
        self.settle_after = 0;
        self.expires_at = 0;
        self.task_id = 0;
        self.memo_hash = [0; 32];
        self.redacted = true;
    }

    fn validate_sender_deposit(&self, deposit: &Deposit) -> Result<()> {
        require_keys_eq!(
            deposit.user,
            self.sender,
            ProtectedPayError::PaymentDepositMismatch
        );
        require_keys_eq!(
            deposit.token_mint,
            self.token_mint,
            ProtectedPayError::WrongMint
        );
        Ok(())
    }

    fn validate_claimant_deposit(&self, deposit: &Deposit, actor: Pubkey) -> Result<()> {
        require_keys_eq!(
            deposit.user,
            actor,
            ProtectedPayError::PaymentDepositMismatch
        );
        require_keys_eq!(
            deposit.token_mint,
            self.token_mint,
            ProtectedPayError::WrongMint
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum CrankProbeStatus {
    Pending,
    Advanced,
}

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct CrankProbe {
    pub owner: Pubkey,
    pub deposit: Pubkey,
    pub not_before: i64,
    pub task_id: i64,
    pub transition_count: u64,
    pub status: CrankProbeStatus,
    pub version: u8,
    pub bump: u8,
}

impl CrankProbe {
    pub fn advance(&mut self, deposit: &mut Deposit, now: i64) -> Result<()> {
        require_keys_eq!(
            self.deposit,
            deposit.key_for_probe(),
            ProtectedPayError::ProbeDepositMismatch
        );
        require_keys_eq!(
            self.owner,
            deposit.user,
            ProtectedPayError::ProbeDepositMismatch
        );
        if self.status == CrankProbeStatus::Advanced {
            return Ok(());
        }
        require!(
            now >= self.not_before,
            ProtectedPayError::AutomationTooEarly
        );
        deposit.next_payment_nonce = deposit
            .next_payment_nonce
            .checked_add(1)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        self.transition_count = self
            .transition_count
            .checked_add(1)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        self.status = CrankProbeStatus::Advanced;
        Ok(())
    }
}

impl Vault {
    pub fn record_deposit(&mut self, deposit: &mut Deposit, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);

        let available = deposit
            .available
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        let total_liability = self
            .total_liability
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;

        deposit.available = available;
        self.total_liability = total_liability;
        Ok(())
    }

    pub fn record_withdrawal(&mut self, deposit: &mut Deposit, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);

        let available = deposit
            .available
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::InsufficientAvailable))?;
        let total_liability = self
            .total_liability
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::LiabilityMismatch))?;

        deposit.available = available;
        self.total_liability = total_liability;
        Ok(())
    }
}

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Deposit {
    pub user: Pubkey,
    pub token_mint: Pubkey,
    pub available: u64,
    pub locked: u64,
    pub next_payment_nonce: u64,
    pub automation_paused: bool,
    pub version: u8,
}

impl Deposit {
    fn key_for_probe(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[DEPOSIT_SEED, self.user.as_ref(), self.token_mint.as_ref()],
            &crate::ID,
        )
        .0
    }

    pub fn total_liability(&self) -> Result<u64> {
        self.available
            .checked_add(self.locked)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))
    }

    pub fn credit(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        self.available = self
            .available
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        Ok(())
    }

    pub fn debit_available(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        self.available = self
            .available
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::InsufficientAvailable))?;
        Ok(())
    }

    pub fn lock(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        let available = self
            .available
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::InsufficientAvailable))?;
        let locked = self
            .locked
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        self.available = available;
        self.locked = locked;
        Ok(())
    }

    pub fn unlock(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        let locked = self
            .locked
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::InsufficientLocked))?;
        let available = self
            .available
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        self.locked = locked;
        self.available = available;
        Ok(())
    }

    pub fn settle_locked_to(&mut self, recipient: &mut Deposit, amount: u64) -> Result<()> {
        require!(amount > 0, ProtectedPayError::InvalidAmount);
        require_keys_eq!(
            self.token_mint,
            recipient.token_mint,
            ProtectedPayError::WrongMint
        );
        require_keys_neq!(self.user, recipient.user, ProtectedPayError::SameParty);

        let sender_locked = self
            .locked
            .checked_sub(amount)
            .ok_or_else(|| error!(ProtectedPayError::InsufficientLocked))?;
        let recipient_available = recipient
            .available
            .checked_add(amount)
            .ok_or_else(|| error!(ProtectedPayError::MathOverflow))?;
        self.locked = sender_locked;
        recipient.available = recipient_available;
        Ok(())
    }
}

#[error_code]
pub enum ProtectedPayError {
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Invalid timing window")]
    InvalidWindow,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Available balance is too low")]
    InsufficientAvailable,
    #[msg("Locked balance is too low")]
    InsufficientLocked,
    #[msg("Liability mismatch")]
    LiabilityMismatch,
    #[msg("Wrong token mint")]
    WrongMint,
    #[msg("Wrong token program")]
    WrongTokenProgram,
    #[msg("Wrong Private ER validator")]
    WrongValidator,
    #[msg("Invalid Private ER validator")]
    InvalidValidator,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Invalid Crank schedule")]
    InvalidCrankSchedule,
    #[msg("Automation is not due")]
    AutomationTooEarly,
    #[msg("CrankProbe Deposit mismatch")]
    ProbeDepositMismatch,
    #[msg("Sender and recipient must differ")]
    SameParty,
    #[msg("Payment shell is invalid")]
    InvalidPaymentShell,
    #[msg("Payment is already open")]
    PaymentAlreadyOpen,
    #[msg("Payment has not been opened")]
    PaymentNotOpen,
    #[msg("Payment state does not allow this transition")]
    InvalidPaymentStatus,
    #[msg("Payment acknowledgement window has ended")]
    PaymentExpired,
    #[msg("Payment Deposit relationship is invalid")]
    PaymentDepositMismatch,
    #[msg("Payment must be terminal before redaction")]
    PaymentNotTerminal,
    #[msg("Payment has been redacted")]
    PaymentRedacted,
    #[msg("Payment must be redacted before public commitment")]
    NotRedacted,
    #[msg("A Crank task is already registered for this payment")]
    TaskAlreadyScheduled,
    #[msg("Account is not owned by Protected Pay")]
    InvalidAccountOwner,
    #[msg("Recipient address is invalid")]
    InvalidRecipient,
    #[msg("Payment account uses an unsupported state-machine version")]
    UnsupportedPaymentVersion,
    #[msg("Terminal payment funds must be claimed before redaction")]
    PaymentFundsUnclaimed,
    #[msg("Payment is not ready for this claimant")]
    PaymentNotClaimable,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_deposit() -> Deposit {
        Deposit {
            user: Pubkey::new_unique(),
            token_mint: Pubkey::new_unique(),
            available: 0,
            locked: 0,
            next_payment_nonce: 0,
            automation_paused: false,
            version: 1,
        }
    }

    fn empty_vault(mint: Pubkey) -> Vault {
        Vault {
            token_mint: mint,
            total_liability: 0,
            bump: 255,
        }
    }

    fn pending_probe(deposit: &Deposit, not_before: i64) -> CrankProbe {
        CrankProbe {
            owner: deposit.user,
            deposit: deposit.key_for_probe(),
            not_before,
            task_id: 42,
            transition_count: 0,
            status: CrankProbeStatus::Pending,
            version: 1,
            bump: 254,
        }
    }

    fn payment_fixture(sender_available: u64) -> (Payment, Deposit, Deposit) {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let payment = Payment {
            payment_id: [7; 32],
            sender,
            recipient,
            token_mint: mint,
            amount: 0,
            created_at: 0,
            settle_after: 0,
            expires_at: 0,
            task_id: 0,
            status: PaymentStatus::Created,
            memo_hash: [0; 32],
            terminal_commitment: [0; 32],
            initialized: false,
            redacted: false,
            version: PAYMENT_VERSION,
            bump: 253,
        };
        let sender_deposit = Deposit {
            user: sender,
            token_mint: mint,
            available: sender_available,
            locked: 0,
            next_payment_nonce: 0,
            automation_paused: false,
            version: 1,
        };
        let recipient_deposit = Deposit {
            user: recipient,
            token_mint: mint,
            available: 0,
            locked: 0,
            next_payment_nonce: 0,
            automation_paused: false,
            version: 1,
        };
        (payment, sender_deposit, recipient_deposit)
    }

    fn system_liability(payment: &Payment, sender: &Deposit, recipient: &Deposit) -> u64 {
        sender.total_liability().unwrap() + recipient.total_liability().unwrap() + payment.amount
    }

    #[test]
    fn timing_policy_updates_only_with_valid_ordered_windows() {
        let mut config = Config {
            authority: Pubkey::new_unique(),
            allowed_mint: Pubkey::new_unique(),
            token_program: anchor_spl::token::ID,
            safety_window_seconds: 300,
            claim_window_seconds: 86_400,
            private_validator: Pubkey::new_unique(),
            version: 1,
            bump: 255,
        };
        config.update_timing_policy(60, 300).unwrap();
        assert_eq!(config.safety_window_seconds, 60);
        assert_eq!(config.claim_window_seconds, 300);

        assert!(config.update_timing_policy(0, 300).is_err());
        assert!(config.update_timing_policy(300, 300).is_err());
        assert_eq!(config.safety_window_seconds, 60);
        assert_eq!(config.claim_window_seconds, 300);
    }

    #[test]
    fn opening_moves_exact_amount_into_payment_escrow() {
        let (mut payment, mut sender, _) = payment_fixture(10_000_000);
        let actor = payment.sender;
        let memo_hash = [9; 32];

        payment
            .open(&mut sender, actor, 3_000_000, memo_hash, 100, 60, 300)
            .unwrap();

        assert_eq!(sender.available, 7_000_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(sender.next_payment_nonce, 1);
        assert_eq!(payment.amount, 3_000_000);
        assert_eq!(payment.created_at, 100);
        assert_eq!(payment.settle_after, 160);
        assert_eq!(payment.expires_at, 400);
        assert_eq!(payment.memo_hash, memo_hash);
        assert_eq!(payment.status, PaymentStatus::Created);

        assert!(payment
            .open(&mut sender, actor, 1, [1; 32], 101, 60, 300)
            .is_err());
        assert_eq!(sender.available, 7_000_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(payment.amount, 3_000_000);
    }

    #[test]
    fn acknowledged_payment_settles_once_after_safety_window() {
        let (mut payment, mut sender, mut recipient) = payment_fixture(8_000_000);
        let sender_actor = payment.sender;
        let recipient_actor = payment.recipient;
        let initial_liability = system_liability(&payment, &sender, &recipient);
        payment
            .open(
                &mut sender,
                sender_actor,
                2_500_000,
                [3; 32],
                1_000,
                60,
                300,
            )
            .unwrap();
        payment.acknowledge(recipient_actor, 1_010).unwrap();

        payment.advance(1_059).unwrap();
        assert_eq!(payment.status, PaymentStatus::Acknowledged);
        assert_eq!(recipient.available, 0);
        assert_eq!(
            system_liability(&payment, &sender, &recipient),
            initial_liability
        );

        payment.advance(1_060).unwrap();
        assert_eq!(payment.status, PaymentStatus::Settled);
        assert_eq!(sender.available, 5_500_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(recipient.available, 0);
        assert_eq!(payment.amount, 2_500_000);
        assert_eq!(
            system_liability(&payment, &sender, &recipient),
            initial_liability
        );

        payment.claim(&mut recipient, recipient_actor).unwrap();
        assert_eq!(recipient.available, 2_500_000);
        assert_eq!(payment.amount, 0);
        assert!(payment.redacted);
        assert_eq!(
            system_liability(&payment, &sender, &recipient),
            initial_liability
        );

        payment.advance(9_999).unwrap();
        assert_eq!(recipient.available, 2_500_000);
        assert!(payment.claim(&mut recipient, recipient_actor).is_err());
        assert_eq!(
            system_liability(&payment, &sender, &recipient),
            initial_liability
        );
    }

    #[test]
    fn sender_can_cancel_and_later_crank_calls_are_noops() {
        let (mut payment, mut sender, recipient) = payment_fixture(4_000_000);
        let actor = payment.sender;
        payment
            .open(&mut sender, actor, 1_250_000, [4; 32], 20, 60, 300)
            .unwrap();
        payment.cancel(&mut sender, actor).unwrap();
        assert_eq!(payment.status, PaymentStatus::Cancelled);
        assert_eq!(sender.available, 4_000_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(payment.amount, 0);
        assert!(payment.redacted);
        assert_ne!(payment.terminal_commitment, [0; 32]);

        assert!(payment.cancel(&mut sender, actor).is_err());
        payment.advance(1_000).unwrap();
        assert_eq!(sender.available, 4_000_000);
        assert_eq!(recipient.available, 0);
    }

    #[test]
    fn unacknowledged_payment_expires_at_exact_boundary() {
        let (mut payment, mut sender, recipient) = payment_fixture(5_000_000);
        let sender_actor = payment.sender;
        let recipient_actor = payment.recipient;
        payment
            .open(&mut sender, sender_actor, 2_000_000, [5; 32], 100, 60, 300)
            .unwrap();

        payment.advance(399).unwrap();
        assert_eq!(payment.status, PaymentStatus::Created);
        assert!(payment.acknowledge(recipient_actor, 400).is_err());
        payment.advance(400).unwrap();
        assert_eq!(payment.status, PaymentStatus::Expired);
        assert_eq!(sender.available, 3_000_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(payment.amount, 2_000_000);
        assert_eq!(recipient.available, 0);

        payment.claim(&mut sender, sender_actor).unwrap();
        assert_eq!(sender.available, 5_000_000);
        assert_eq!(payment.amount, 0);
        assert!(payment.redacted);
    }

    #[test]
    fn six_immediate_first_crank_iterations_reach_expiry_boundary() {
        let (mut payment, mut sender, _) = payment_fixture(5_000_000);
        let sender_actor = payment.sender;
        let created_at = 100;
        payment
            .open(
                &mut sender,
                sender_actor,
                2_000_000,
                [5; 32],
                created_at,
                60,
                300,
            )
            .unwrap();

        let interval_seconds = PAYMENT_CRANK_INTERVAL_MILLIS / 1_000;
        for iteration in 0..PAYMENT_CRANK_ITERATIONS {
            let execution_time = created_at + iteration * interval_seconds;
            payment.advance(execution_time).unwrap();

            if iteration + 1 < PAYMENT_CRANK_ITERATIONS {
                assert_eq!(payment.status, PaymentStatus::Created);
            } else {
                assert_eq!(execution_time, payment.expires_at);
                assert_eq!(payment.status, PaymentStatus::Expired);
            }
        }
    }

    #[test]
    fn authorization_and_deposit_substitution_fail_without_mutation() {
        let (mut payment, mut sender, mut recipient) = payment_fixture(6_000_000);
        let sender_actor = payment.sender;
        let recipient_actor = payment.recipient;
        payment
            .open(&mut sender, sender_actor, 1_000_000, [6; 32], 0, 60, 300)
            .unwrap();

        assert!(payment.acknowledge(Pubkey::new_unique(), 1).is_err());
        assert!(payment.cancel(&mut sender, Pubkey::new_unique()).is_err());
        assert_eq!(payment.status, PaymentStatus::Created);
        assert_eq!(sender.available, 5_000_000);
        assert_eq!(sender.locked, 0);

        payment.acknowledge(recipient_actor, 1).unwrap();
        payment.advance(60).unwrap();
        assert!(payment.claim(&mut sender, sender_actor).is_err());
        recipient.user = Pubkey::new_unique();
        assert!(payment.claim(&mut recipient, recipient_actor).is_err());
        assert_eq!(payment.status, PaymentStatus::Settled);
        assert_eq!(payment.amount, 1_000_000);
        assert_eq!(recipient.available, 0);
    }

    #[test]
    fn cancel_and_settle_races_have_only_one_winner() {
        let (mut settled, mut sender_a, mut recipient_a) = payment_fixture(3_000_000);
        let settled_sender = settled.sender;
        let settled_recipient = settled.recipient;
        settled
            .open(
                &mut sender_a,
                settled_sender,
                1_000_000,
                [1; 32],
                0,
                60,
                300,
            )
            .unwrap();
        settled.acknowledge(settled_recipient, 1).unwrap();
        settled.advance(60).unwrap();
        assert!(settled.cancel(&mut sender_a, settled_sender).is_err());
        settled.claim(&mut recipient_a, settled_recipient).unwrap();
        assert_eq!(recipient_a.available, 1_000_000);

        let (mut cancelled, mut sender_b, recipient_b) = payment_fixture(3_000_000);
        let cancelled_sender = cancelled.sender;
        let cancelled_recipient = cancelled.recipient;
        cancelled
            .open(
                &mut sender_b,
                cancelled_sender,
                1_000_000,
                [2; 32],
                0,
                60,
                300,
            )
            .unwrap();
        cancelled.acknowledge(cancelled_recipient, 1).unwrap();
        cancelled.cancel(&mut sender_b, cancelled_sender).unwrap();
        cancelled.advance(60).unwrap();
        assert_eq!(cancelled.status, PaymentStatus::Cancelled);
        assert_eq!(sender_b.available, 3_000_000);
        assert_eq!(recipient_b.available, 0);
    }

    #[test]
    fn settlement_overflow_is_atomic() {
        let (mut payment, mut sender, mut recipient) = payment_fixture(2);
        let sender_actor = payment.sender;
        let recipient_actor = payment.recipient;
        recipient.available = u64::MAX;
        payment
            .open(&mut sender, sender_actor, 1, [8; 32], 0, 1, 2)
            .unwrap();
        payment.acknowledge(recipient_actor, 0).unwrap();

        payment.advance(1).unwrap();
        assert!(payment.claim(&mut recipient, recipient_actor).is_err());
        assert_eq!(payment.status, PaymentStatus::Settled);
        assert_eq!(sender.available, 1);
        assert_eq!(sender.locked, 0);
        assert_eq!(payment.amount, 1);
        assert!(!payment.redacted);
        assert_eq!(recipient.available, u64::MAX);
    }

    #[test]
    fn terminal_redaction_is_required_shape_and_idempotent() {
        let (mut payment, mut sender, mut recipient) = payment_fixture(2_000_000);
        let sender_actor = payment.sender;
        let original_recipient = payment.recipient;
        payment
            .open(&mut sender, sender_actor, 500_000, [11; 32], 1_000, 60, 300)
            .unwrap();
        assert!(payment.redact().is_err());
        payment.acknowledge(original_recipient, 1_001).unwrap();
        payment.advance(1_060).unwrap();
        assert!(payment.redact().is_err());
        payment.claim(&mut recipient, original_recipient).unwrap();

        let commitment = payment.terminal_commitment;
        assert_ne!(commitment, [0; 32]);
        assert_eq!(payment.sender, sender_actor);
        assert_eq!(payment.recipient, Pubkey::default());
        assert_eq!(payment.amount, 0);
        assert_eq!(payment.memo_hash, [0; 32]);
        assert_eq!(payment.created_at, 0);
        assert_eq!(payment.settle_after, 0);
        assert_eq!(payment.expires_at, 0);
        assert!(payment.redacted);

        payment.redact().unwrap();
        assert_eq!(payment.terminal_commitment, commitment);
    }

    #[test]
    fn invalid_open_terms_do_not_mutate_payment_or_balance() {
        let (mut payment, mut sender, _) = payment_fixture(1_000_000);
        let actor = payment.sender;

        assert!(payment
            .open(&mut sender, actor, 0, [0; 32], 10, 60, 300)
            .is_err());
        assert!(!payment.initialized);
        assert_eq!(sender.available, 1_000_000);
        assert_eq!(sender.locked, 0);

        payment.recipient = actor;
        assert!(payment
            .open(&mut sender, actor, 1, [0; 32], 10, 60, 300)
            .is_err());
        assert!(!payment.initialized);

        payment.recipient = Pubkey::new_unique();
        assert!(payment
            .open(&mut sender, actor, 1, [0; 32], i64::MAX, 60, 300)
            .is_err());
        assert!(!payment.initialized);
        assert_eq!(sender.available, 1_000_000);
        assert_eq!(sender.next_payment_nonce, 0);
    }

    #[test]
    fn crank_schedule_can_only_be_registered_by_the_stored_sender() {
        let (mut payment, mut sender, _) = payment_fixture(1_000_000);
        let actor = payment.sender;
        payment
            .open(&mut sender, actor, 1, [0; 32], 0, 60, 300)
            .unwrap();
        payment.validate_schedule_actor(actor).unwrap();
        assert!(payment
            .validate_schedule_actor(Pubkey::new_unique())
            .is_err());

        payment.status = PaymentStatus::Cancelled;
        assert!(payment.validate_schedule_actor(actor).is_err());
    }

    #[test]
    fn version_one_payment_cannot_enter_the_escrow_state_machine() {
        let (mut payment, mut sender, _) = payment_fixture(1_000_000);
        let actor = payment.sender;
        payment.version = 1;

        assert!(payment
            .open(&mut sender, actor, 500_000, [1; 32], 0, 60, 300)
            .is_err());
        assert_eq!(sender.available, 1_000_000);
        assert_eq!(sender.locked, 0);
        assert_eq!(payment.amount, 0);
        assert!(!payment.initialized);
    }

    #[test]
    fn credit_lock_unlock_and_withdraw_conserve_liability() {
        let mut deposit = empty_deposit();

        deposit.credit(10_000_000).unwrap();
        assert_eq!(deposit.total_liability().unwrap(), 10_000_000);

        deposit.lock(3_250_000).unwrap();
        assert_eq!(deposit.available, 6_750_000);
        assert_eq!(deposit.locked, 3_250_000);
        assert_eq!(deposit.total_liability().unwrap(), 10_000_000);

        deposit.unlock(3_250_000).unwrap();
        assert_eq!(deposit.available, 10_000_000);
        assert_eq!(deposit.locked, 0);
        assert_eq!(deposit.total_liability().unwrap(), 10_000_000);

        deposit.debit_available(10_000_000).unwrap();
        assert_eq!(deposit.total_liability().unwrap(), 0);
    }

    #[test]
    fn cannot_withdraw_or_lock_more_than_available() {
        let mut deposit = empty_deposit();
        deposit.credit(1_000_000).unwrap();

        assert!(deposit.debit_available(1_000_001).is_err());
        assert_eq!(deposit.available, 1_000_000);

        assert!(deposit.lock(1_000_001).is_err());
        assert_eq!(deposit.available, 1_000_000);
        assert_eq!(deposit.locked, 0);
    }

    #[test]
    fn locked_funds_cannot_be_withdrawn() {
        let mut deposit = empty_deposit();
        deposit.credit(2_000_000).unwrap();
        deposit.lock(1_500_000).unwrap();

        assert!(deposit.debit_available(1_000_000).is_err());
        assert_eq!(deposit.available, 500_000);
        assert_eq!(deposit.locked, 1_500_000);
    }

    #[test]
    fn zero_amounts_and_overflow_fail_without_changing_state() {
        let mut deposit = empty_deposit();
        assert!(deposit.credit(0).is_err());
        assert!(deposit.lock(0).is_err());
        assert!(deposit.unlock(0).is_err());
        assert!(deposit.debit_available(0).is_err());

        deposit.available = u64::MAX;
        assert!(deposit.credit(1).is_err());
        assert_eq!(deposit.available, u64::MAX);
    }

    #[test]
    fn failed_unlock_does_not_change_balances() {
        let mut deposit = empty_deposit();
        deposit.credit(2_000_000).unwrap();
        deposit.lock(500_000).unwrap();

        assert!(deposit.unlock(500_001).is_err());
        assert_eq!(deposit.available, 1_500_000);
        assert_eq!(deposit.locked, 500_000);
    }

    #[test]
    fn vault_liability_tracks_collateralized_deposits_and_withdrawals() {
        let mut deposit = empty_deposit();
        let mut vault = empty_vault(deposit.token_mint);

        vault.record_deposit(&mut deposit, 8_000_000).unwrap();
        assert_eq!(deposit.total_liability().unwrap(), 8_000_000);
        assert_eq!(vault.total_liability, 8_000_000);

        deposit.lock(3_000_000).unwrap();
        assert_eq!(vault.total_liability, 8_000_000);
        assert!(vault.record_withdrawal(&mut deposit, 6_000_000).is_err());
        assert_eq!(vault.total_liability, 8_000_000);

        deposit.unlock(3_000_000).unwrap();
        vault.record_withdrawal(&mut deposit, 8_000_000).unwrap();
        assert_eq!(deposit.total_liability().unwrap(), 0);
        assert_eq!(vault.total_liability, 0);
    }

    #[test]
    fn vault_and_deposit_overflow_fail_atomically() {
        let mut deposit = empty_deposit();
        let mut vault = empty_vault(deposit.token_mint);

        deposit.available = u64::MAX;
        assert!(vault.record_deposit(&mut deposit, 1).is_err());
        assert_eq!(deposit.available, u64::MAX);
        assert_eq!(vault.total_liability, 0);

        deposit.available = 10;
        vault.total_liability = u64::MAX;
        assert!(vault.record_deposit(&mut deposit, 1).is_err());
        assert_eq!(deposit.available, 10);
        assert_eq!(vault.total_liability, u64::MAX);
    }

    #[test]
    fn crank_probe_rejects_early_execution_without_mutation() {
        let mut deposit = empty_deposit();
        let mut probe = pending_probe(&deposit, 100);

        assert!(probe.advance(&mut deposit, 99).is_err());
        assert_eq!(probe.status, CrankProbeStatus::Pending);
        assert_eq!(probe.transition_count, 0);
        assert_eq!(deposit.next_payment_nonce, 0);
    }

    #[test]
    fn crank_probe_advances_once_and_replays_are_noops() {
        let mut deposit = empty_deposit();
        let mut probe = pending_probe(&deposit, 100);

        probe.advance(&mut deposit, 100).unwrap();
        assert_eq!(probe.status, CrankProbeStatus::Advanced);
        assert_eq!(probe.transition_count, 1);
        assert_eq!(deposit.next_payment_nonce, 1);

        probe.advance(&mut deposit, 101).unwrap();
        assert_eq!(probe.transition_count, 1);
        assert_eq!(deposit.next_payment_nonce, 1);
    }

    #[test]
    fn crank_probe_rejects_an_unlinked_deposit() {
        let mut deposit = empty_deposit();
        let mut probe = pending_probe(&deposit, 100);
        probe.deposit = Pubkey::new_unique();

        assert!(probe.advance(&mut deposit, 100).is_err());
        assert_eq!(probe.status, CrankProbeStatus::Pending);
        assert_eq!(probe.transition_count, 0);
        assert_eq!(deposit.next_payment_nonce, 0);
    }
}
