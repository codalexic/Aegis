//! Vault lifecycle and policy-enforced swaps through the fixed-rate demo exchange.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use demo_dex::{program::DemoDex, Pool};

declare_id!("E6QbymjuPGqyKeQBCo2rfXiRv1Bp55uM7yVYEDnzxDhe");

#[program]
pub mod aegis {
    use super::*;

    pub fn create_vault(
        ctx: Context<CreateVault>,
        vault_id: u64,
        agent: Pubkey,
        max_trade_raw: u64,
        budget_raw: u64,
        expiry_unix: i64,
    ) -> Result<()> {
        ctx.accounts.vault.set_inner(Vault {
            owner: ctx.accounts.owner.key(),
            agent,
            vault_id,
            input_mint: ctx.accounts.input_mint.key(),
            output_mint: ctx.accounts.output_mint.key(),
            input_vault: ctx.accounts.input_vault.key(),
            output_vault: ctx.accounts.output_vault.key(),
            max_trade_raw,
            budget_raw,
            expiry_unix,
            spent_raw: 0,
            revoked: false,
            bump: ctx.bumps.vault,
            authority_bump: ctx.bumps.vault_authority,
        });
        Ok(())
    }

    pub fn execute_swap<'info>(
        ctx: Context<'info, ExecuteSwap<'info>>,
        amount_in_raw: u64,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        // 1. Only the vault's agent may trade.
        require_keys_eq!(
            ctx.accounts.agent.key(),
            vault.agent,
            AegisError::Unauthorized
        );

        // 2. Revocation precedes expiry; use chain time, not caller input.
        require!(!vault.revoked, AegisError::Revoked);
        require!(
            Clock::get()?.unix_timestamp < vault.expiry_unix,
            AegisError::Expired
        );

        // 3. Validate the amount, cap, then cumulative budget without wrapping.
        require!(amount_in_raw > 0, AegisError::InvalidAmount);
        require!(
            amount_in_raw <= vault.max_trade_raw,
            AegisError::CapExceeded
        );
        let next_spent = vault
            .spent_raw
            .checked_add(amount_in_raw)
            .ok_or(AegisError::BudgetExceeded)?;
        require!(next_spent <= vault.budget_raw, AegisError::BudgetExceeded);

        // 4. Defer account validation until after policy checks, mapping failures
        // to AccountMismatch. Typed conversions retain owner/data/executable checks.
        require_keys_eq!(
            ctx.accounts.input_vault.key(),
            vault.input_vault,
            AegisError::AccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.output_vault.key(),
            vault.output_vault,
            AegisError::AccountMismatch
        );
        let (pool_key, pool_bump) = Pubkey::find_program_address(
            &[
                b"pool",
                vault.input_mint.as_ref(),
                vault.output_mint.as_ref(),
            ],
            &demo_dex::ID,
        );
        require_keys_eq!(
            ctx.accounts.pool.key(),
            pool_key,
            AegisError::AccountMismatch
        );
        let pool = Account::<Pool>::try_from(&ctx.accounts.pool)
            .map_err(|_| error!(AegisError::AccountMismatch))?;
        require_keys_eq!(
            ctx.accounts.input_reserve.key(),
            pool.input_reserve,
            AegisError::AccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.output_reserve.key(),
            pool.output_reserve,
            AegisError::AccountMismatch
        );
        Program::<DemoDex>::try_from(ctx.accounts.demo_dex_program.as_ref())
            .map_err(|_| error!(AegisError::AccountMismatch))?;
        Program::<Token>::try_from(ctx.accounts.token_program.as_ref())
            .map_err(|_| error!(AegisError::AccountMismatch))?;

        let vault_key = vault.key();
        let expected_vault = Pubkey::create_program_address(
            &[
                b"vault",
                vault.owner.as_ref(),
                &vault.vault_id.to_le_bytes(),
                &[vault.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(AegisError::AccountMismatch))?;
        require_keys_eq!(vault_key, expected_vault, AegisError::AccountMismatch);
        let authority_bump = [vault.authority_bump];
        let authority_seeds = &[b"authority".as_ref(), vault_key.as_ref(), &authority_bump];
        let authority = Pubkey::create_program_address(authority_seeds, &crate::ID)
            .map_err(|_| error!(AegisError::AccountMismatch))?;
        require_keys_eq!(
            ctx.accounts.vault_authority.key(),
            authority,
            AegisError::AccountMismatch
        );
        require!(pool.bump == pool_bump, AegisError::AccountMismatch);
        require_keys_eq!(
            pool.input_mint,
            vault.input_mint,
            AegisError::AccountMismatch
        );
        require_keys_eq!(
            pool.output_mint,
            vault.output_mint,
            AegisError::AccountMismatch
        );
        let pool_authority = Pubkey::create_program_address(
            &[b"pool-authority", pool_key.as_ref(), &[pool.authority_bump]],
            &demo_dex::ID,
        )
        .map_err(|_| error!(AegisError::AccountMismatch))?;
        require_keys_eq!(
            ctx.accounts.pool_authority.key(),
            pool_authority,
            AegisError::AccountMismatch
        );
        let mut input =
            checked_token_account(&ctx.accounts.input_vault, vault.input_mint, authority)?;
        let mut output =
            checked_token_account(&ctx.accounts.output_vault, vault.output_mint, authority)?;
        checked_token_account(
            &ctx.accounts.input_reserve,
            vault.input_mint,
            pool_authority,
        )?;
        checked_token_account(
            &ctx.accounts.output_reserve,
            vault.output_mint,
            pool_authority,
        )?;

        // 5. Snapshot, invoke the fixed exchange with the vault PDA, then reload.
        let input_before = input.amount;
        let output_before = output.amount;
        demo_dex::cpi::swap(
            CpiContext::new_with_signer(
                ctx.accounts.demo_dex_program.key(),
                demo_dex::cpi::accounts::Swap {
                    user_authority: ctx.accounts.vault_authority.to_account_info(),
                    pool: ctx.accounts.pool.to_account_info(),
                    pool_authority: ctx.accounts.pool_authority.to_account_info(),
                    user_input: ctx.accounts.input_vault.to_account_info(),
                    user_output: ctx.accounts.output_vault.to_account_info(),
                    input_reserve: ctx.accounts.input_reserve.to_account_info(),
                    output_reserve: ctx.accounts.output_reserve.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                &[authority_seeds],
            ),
            amount_in_raw,
        )?;
        input
            .reload()
            .map_err(|_| error!(AegisError::SwapResultMismatch))?;
        output
            .reload()
            .map_err(|_| error!(AegisError::SwapResultMismatch))?;

        // 6. Require exact input debit and at least the fixed-rate output credit.
        require!(
            input_before.checked_sub(input.amount) == Some(amount_in_raw),
            AegisError::SwapResultMismatch
        );
        let minimum_output = amount_in_raw
            .checked_mul(demo_dex::RATE_MULTIPLIER)
            .ok_or(AegisError::SwapResultMismatch)?;
        let output_received = output
            .amount
            .checked_sub(output_before)
            .ok_or(AegisError::SwapResultMismatch)?;
        require!(
            output_received >= minimum_output,
            AegisError::SwapResultMismatch
        );

        // 7. Commit the checked sum from step 3 only after verifying both balances.
        ctx.accounts.vault.spent_raw = next_spent;
        Ok(())
    }

    pub fn revoke_agent(ctx: Context<RevokeAgent>) -> Result<()> {
        ctx.accounts.vault.revoked = true;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount_raw: u64) -> Result<()> {
        require!(amount_raw > 0, AegisError::InvalidAmount);

        let vault_key = ctx.accounts.vault.key();
        let authority_bump = [ctx.accounts.vault.authority_bump];
        let seeds = &[b"authority".as_ref(), vault_key.as_ref(), &authority_bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount_raw,
        )
    }
}

fn checked_token_account<'info>(
    info: &'info UncheckedAccount<'info>,
    mint: Pubkey,
    authority: Pubkey,
) -> Result<Account<'info, TokenAccount>> {
    let account =
        Account::<TokenAccount>::try_from(info).map_err(|_| error!(AegisError::AccountMismatch))?;
    require_keys_eq!(account.mint, mint, AegisError::AccountMismatch);
    require_keys_eq!(account.owner, authority, AegisError::AccountMismatch);
    Ok(account)
}

#[derive(Accounts)]
#[instruction(vault_id: u64, agent: Pubkey, max_trade_raw: u64, budget_raw: u64, expiry_unix: i64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump,
        constraint = max_trade_raw > 0 && max_trade_raw <= budget_raw @ AegisError::InvalidAmount,
        constraint = expiry_unix > Clock::get()?.unix_timestamp @ AegisError::InvalidAmount,
        // Check before initializing ATAs, which would coincide for equal mints.
        constraint = input_mint.key() != output_mint.key() @ AegisError::InvalidAmount
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: This PDA is used only as a token authority; its seeds are checked here.
    #[account(seeds = [b"authority", vault.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = input_mint,
        associated_token::authority = vault_authority
    )]
    pub input_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = output_mint,
        associated_token::authority = vault_authority
    )]
    pub output_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    pub agent: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: Step 4 validates the vault authority PDA before signing the CPI.
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the stored key, SPL Token account, mint and authority.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the stored key, SPL Token account, mint and authority.
    #[account(mut)]
    pub output_vault: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the canonical PDA, owner, discriminator and fields.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the exchange authority PDA.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the stored reserve, SPL Token account, mint and authority.
    #[account(mut)]
    pub input_reserve: UncheckedAccount<'info>,
    /// CHECK: Step 4 validates the stored reserve, SPL Token account, mint and authority.
    #[account(mut)]
    pub output_reserve: UncheckedAccount<'info>,
    /// CHECK: Step 4 uses Program<DemoDex> to validate the program ID and executable flag.
    pub demo_dex_program: UncheckedAccount<'info>,
    /// CHECK: Step 4 uses Program<Token> to validate the original SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner @ AegisError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner @ AegisError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: Only used as the transfer authority; seeds and stored bump are checked.
    #[account(
        seeds = [b"authority", vault.key().as_ref()],
        bump = vault.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = (source.key() == vault.input_vault && source.mint == vault.input_mint)
            || (source.key() == vault.output_vault && source.mint == vault.output_mint)
            @ AegisError::AccountMismatch,
        constraint = source.owner == vault_authority.key() @ AegisError::AccountMismatch
    )]
    pub source: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = destination.owner == owner.key() @ AegisError::AccountMismatch,
        constraint = destination.mint == source.mint @ AegisError::AccountMismatch
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub vault_id: u64,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub max_trade_raw: u64,
    pub budget_raw: u64,
    pub expiry_unix: i64,
    pub spent_raw: u64,
    pub revoked: bool,
    pub bump: u8,
    pub authority_bump: u8,
}

#[error_code]
pub enum AegisError {
    #[msg("The signer is not the authorized owner or agent")]
    Unauthorized,
    #[msg("The agent has been revoked")]
    Revoked,
    #[msg("The vault has expired")]
    Expired,
    #[msg("The amount or vault policy is invalid")]
    InvalidAmount,
    #[msg("The amount exceeds the per-trade cap")]
    CapExceeded,
    #[msg("The amount exceeds the remaining budget")]
    BudgetExceeded,
    #[msg("An account does not match the required mint, pool, program, or destination")]
    AccountMismatch,
    #[msg("The swap did not produce the expected balance changes")]
    SwapResultMismatch,
}
