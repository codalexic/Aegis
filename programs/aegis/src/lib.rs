//! P1 interface scaffold. Handler logic and policy checks are added in P2 and P4.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use demo_dex::{program::DemoDex, Pool};

declare_id!("E6QbymjuPGqyKeQBCo2rfXiRv1Bp55uM7yVYEDnzxDhe");

#[program]
pub mod aegis {
    use super::*;

    pub fn create_vault(
        _ctx: Context<CreateVault>,
        vault_id: u64,
        agent: Pubkey,
        max_trade_raw: u64,
        budget_raw: u64,
        expiry_unix: i64,
    ) -> Result<()> {
        let _ = (vault_id, agent, max_trade_raw, budget_raw, expiry_unix);
        Ok(())
    }

    pub fn execute_swap(_ctx: Context<ExecuteSwap>, amount_in_raw: u64) -> Result<()> {
        let _ = amount_in_raw;
        Ok(())
    }

    pub fn revoke_agent(_ctx: Context<RevokeAgent>) -> Result<()> {
        Ok(())
    }

    pub fn withdraw(_ctx: Context<Withdraw>, amount_raw: u64) -> Result<()> {
        let _ = amount_raw;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump
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
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    pub vault: Account<'info, Vault>,
    /// CHECK: Unused by the P1 stub. P2 validates this PDA before signing transfers.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
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
