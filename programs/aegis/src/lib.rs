//! Vault lifecycle. Swap execution and its policy checks are added in P4.

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

    pub fn execute_swap(_ctx: Context<ExecuteSwap>, amount_in_raw: u64) -> Result<()> {
        let _ = amount_in_raw;
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
    /// CHECK: Unused by the P1 stub. P4 validates this PDA before signing the CPI.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub input_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_vault: Account<'info, TokenAccount>,
    pub pool: Account<'info, Pool>,
    /// CHECK: Unused by the P1 stub. P4 validates the exchange's authority PDA.
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub input_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_reserve: Account<'info, TokenAccount>,
    pub demo_dex_program: Program<'info, DemoDex>,
    pub token_program: Program<'info, Token>,
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
