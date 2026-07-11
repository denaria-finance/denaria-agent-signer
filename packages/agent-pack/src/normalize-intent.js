export function normalizeIntent(input = {}) {
  const marketId = normalizeMarket(input.marketId || input.market || input.asset || input.assetTicker)
  const side = normalizeSide(input.side)
  const collateralAmount = normalizeAmount(input.collateralAmount || input.collateral || input.amount || input.usdc)
  const collateralAsset = normalizeCollateral(input.collateralAsset || input.assetCollateral || 'USDC')
  const leverage = normalizeLeverage(input.leverage || input.lev)

  const missing = []
  if (!marketId) missing.push('marketId')
  if (!side) missing.push('side')
  if (!collateralAmount) missing.push('collateralAmount')
  if (!leverage) missing.push('leverage')

  if (missing.length > 0) {
    const error = new Error(`Missing required Denaria intent fields: ${missing.join(', ')}`)
    error.code = 'DENARIA_INTENT_INCOMPLETE'
    error.missing = missing
    throw error
  }

  return {
    marketId,
    side,
    collateralAsset,
    collateralAmount,
    leverage,
  }
}

function normalizeMarket(value) {
  if (!value) return null
  const text = String(value).trim().toUpperCase()
  if (['BTC', 'BITCOIN', 'BTC-USD'].includes(text)) return 'BTC-USD'
  return text.includes('-') ? text : `${text}-USD`
}

function normalizeSide(value) {
  if (!value) return null
  const text = String(value).trim().toLowerCase()
  if (text.includes('long')) return 'long'
  if (text.includes('short')) return 'short'
  return null
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null
  const match = String(value).replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/)
  return match ? match[0] : null
}

function normalizeCollateral(value) {
  const text = String(value || 'USDC').trim().toUpperCase()
  if (text === 'USD' || text === '$') return 'USDC'
  return text
}

function normalizeLeverage(value) {
  if (value === undefined || value === null || value === '') return null
  const match = String(value).toLowerCase().replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/)
  return match ? match[0] : null
}
