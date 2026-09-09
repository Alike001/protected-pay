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

declare_id!("w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const CRANK_PROBE_SEED: &[u8] = b"crank-probe";

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

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub token_mint: Pubkey,
    pub total_liability: u64,
    pub bump: u8,
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
