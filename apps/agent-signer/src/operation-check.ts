import type {
  AgentAdjustMarginInput,
  AgentCancelOrderInput,
  AgentClosePositionInput,
  AgentExecutionAction,
  AgentOperationMarket,
  AgentOperationStep,
  AgentPlaceLimitOrderInput,
  AgentPrepareCreatePositionInput,
  AgentSetTpSlInput,
  AgentUserOp,
} from '@denaria/agent-schemas';
import {
  decodeAbiParameters,
  decodeFunctionData,
  type Hex,
  parseAbi,
  parseUnits,
  slice,
  toFunctionSelector,
} from 'viem';
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction';
import type { Address, SignerContracts } from './contracts.js';
import { SignerError } from './errors.js';

/**
 * What the Signer checks before it signs an operation's UserOp (agent-trading
 * Stage 2 ticket 20, grill Q101, review F7, scan P-03; ADR-0062 §13). The API
 * is assumed compromisable (ADR-0062 §2): it answers the whole UserOp, and the
 * Signer signs the hash it computes itself, for its own chain and the v0.7
 * EntryPoint, only when the UserOp is the tool's request:
 *
 * - the sender is the Grant's account and the UserOp deploys nothing;
 * - its call data is the account's `execute` of plain calls, each to a target
 *   and selector the tool can produce (the legs of the Grant it uses), value
 *   only into WETH, and the service fee only to its receiver;
 * - a trade's GMX orders are of the tool's kind (increase, decrease, TP, SL),
 *   in the market the request named and on its side, and an open's size is at
 *   most collateral × leverage; a cancel cancels the order it names;
 * - a TP or SL at the price asked for it (ticket 25, grill Q108), read like a
 *   limit's trigger below;
 * - a limit or stop increase only from `denaria_place_limit_order` (ticket
 *   19), on a Grant with "Pending limit and stop orders", of the type asked,
 *   at the trigger asked (read with the index token's decimals the API
 *   states), at most collateral × leverage, cancelling only the order it
 *   replaces;
 * - what policy v5 refuses (tickets 18b and 29, ADR-0063 §2–§3, ADR-0065): an
 *   allowance to a spender the Grant does not pin, more than one ETH wrap, an
 *   order dated or with a swap path other than the one hop through the
 *   chain's [USDC-USDG] market (a USDG pool's), any top-up from savings (no
 *   tool calls Aave, Morpho, Permit2, the Universal Router or USDG), and,
 *   without the Grant's "Margin withdrawal", a decrease that takes collateral
 *   out (Remove margin, or a close with a collateral delta: the builders send
 *   0, as GMX pays all the collateral on a full close).
 *
 * Not checked (the chosen scope, ADR-0062 §13): amounts other than the size
 * and the triggers, a TP/SL's size (a decrease closes at most the position)
 * and its side of the market price, the acceptable price, and gas and
 * paymaster fields, which the on-chain policy bounds. A second signature after a relay fault may only
 * change gas and paymaster fields of the first UserOp, whose check holds for
 * it: the API's retry step states no market.
 */

/** The Signer refused to sign: `reason` says what did not match. */
export class SignRefusal extends SignerError {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type SignStep = Extract<AgentOperationStep, { step: 'sign' }>;

/** What the Signer knows of its Grant, read from the API before signing. */
export type GrantToCheck = {
  account: string;
  markets: 'any' | readonly { gmxMarketAddress: string; assetTicker: string | null }[];
  /** Policy v4's two agent settings (ADR-0063 §3), off unless the Grant
   *  read says on. The API can only loosen the Signer's check with them up
   *  to what the policy enforces on-chain for the installed Grant. */
  pendingIncreaseOrdersAllowed: boolean;
  marginWithdrawalAllowed: boolean;
};

/** The tool's request, as its input schema parsed it. */
export type ToolRequest =
  | { action: 'create_position'; input: AgentPrepareCreatePositionInput }
  | { action: 'close_position'; input: AgentClosePositionInput }
  | { action: 'adjust_margin'; input: AgentAdjustMarginInput }
  | { action: 'set_tpsl'; input: AgentSetTpSlInput }
  | { action: 'place_limit_order'; input: AgentPlaceLimitOrderInput }
  | { action: 'cancel_order'; input: AgentCancelOrderInput }
  | { action: 'claim_funding'; input: Record<string, unknown> };

export const SELECTORS = {
  approve: toFunctionSelector('approve(address,uint256)'),
  transfer: toFunctionSelector('transfer(address,uint256)'),
  wethDeposit: toFunctionSelector('deposit()'),
  exactOutputSingle: toFunctionSelector(
    'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  ),
  sendTokens: toFunctionSelector('sendTokens(address,address,uint256)'),
  createOrder: toFunctionSelector(
    'createOrder(((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))',
  ),
  setTraderReferralCodeByUser: toFunctionSelector('setTraderReferralCodeByUser(bytes32)'),
  cancelOrder: toFunctionSelector('cancelOrder(bytes32)'),
  claimFundingFees: toFunctionSelector('claimFundingFees(address[],address[],address)'),
} as const;

const KERNEL_ABI = parseAbi(['function execute(bytes32 execMode, bytes executionCalldata)']);
const EXECUTIONS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const;
const CREATE_ORDER_ABI = parseAbi([
  'struct CreateOrderParamsAddresses { address receiver; address cancellationReceiver; address callbackContract; address uiFeeReceiver; address market; address initialCollateralToken; address[] swapPath; }',
  'struct CreateOrderParamsNumbers { uint256 sizeDeltaUsd; uint256 initialCollateralDeltaAmount; uint256 triggerPrice; uint256 acceptablePrice; uint256 executionFee; uint256 callbackGasLimit; uint256 minOutputAmount; uint256 validFromTime; }',
  'struct CreateOrderParams { CreateOrderParamsAddresses addresses; CreateOrderParamsNumbers numbers; uint8 orderType; uint8 decreasePositionSwapType; bool isLong; bool shouldUnwrapNativeToken; bool autoCancel; bytes32 referralCode; bytes32[] dataList; }',
  'function createOrder(CreateOrderParams params) payable returns (bytes32)',
]);
const CANCEL_ORDER_ABI = parseAbi(['function cancelOrder(bytes32 key)']);
const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount)']);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)']);

/** Kernel v3 `execute` modes: call type (single, batch), default exec type. */
const MODE_SINGLE = `0x${'00'.repeat(32)}`;
const MODE_BATCH = `0x01${'00'.repeat(31)}`;

/** GMX `Order.OrderType`. */
const ORDER_TYPES = {
  MarketIncrease: 2,
  LimitIncrease: 3,
  MarketDecrease: 4,
  LimitDecrease: 5,
  StopLossDecrease: 6,
  StopIncrease: 8,
} as const;
const ORDER_TYPE_NAMES: Record<number, string> = {
  0: 'a market swap',
  1: 'a limit swap',
  2: 'a market increase',
  3: 'a limit increase',
  4: 'a market decrease',
  5: 'a take profit',
  6: 'a stop loss',
  7: 'a liquidation',
  8: 'a stop increase',
};

/** A Grant call leg, by target and selector (`sessionKeyCallPermissionsV5`). */
type Leg =
  | 'usdc-approve'
  | 'service-fee'
  | 'weth-approve'
  | 'weth-deposit'
  | 'keeper-fee-swap'
  | 'gmx-send-tokens'
  | 'gmx-create-order'
  | 'gmx-cancel-order'
  | 'gmx-claim-funding-fees'
  | 'gmx-referral-code-sync';

/** The keeper fee of an order: wrap ETH, or swap USDC for WETH, approve and
 *  send it to GMX; the GMX referral code aligned; the service fee. */
const ORDER_FUNDING: readonly Leg[] = [
  'service-fee',
  'usdc-approve',
  'weth-approve',
  'weth-deposit',
  'keeper-fee-swap',
  'gmx-send-tokens',
  'gmx-referral-code-sync',
];
/** What each tool's batch may call (`apps/api/src/agent-signer/gmx-builder.ts`
 *  and the `@denaria/gmx-batch` builders it uses). */
function legsOf(request: ToolRequest): readonly Leg[] {
  switch (request.action) {
    case 'create_position':
      // An open claims the funding fees first when the user has auto-claim on.
      return [...ORDER_FUNDING, 'gmx-claim-funding-fees', 'gmx-create-order'];
    case 'close_position':
      return [...ORDER_FUNDING, 'gmx-create-order'];
    case 'adjust_margin':
      return [...ORDER_FUNDING, 'gmx-create-order'];
    case 'set_tpsl':
      // A TP or SL the position has is moved by a cancel and a new order.
      return [...ORDER_FUNDING, 'gmx-cancel-order', 'gmx-create-order'];
    case 'place_limit_order':
      // The open's batch with a trigger; a move cancels the order it replaces.
      return [...ORDER_FUNDING, 'gmx-cancel-order', 'gmx-create-order'];
    case 'cancel_order':
      return ['service-fee', 'gmx-cancel-order'];
    case 'claim_funding':
      return ['service-fee', 'gmx-claim-funding-fees'];
  }
}

const TOOL_WORDS: Record<AgentExecutionAction, string> = {
  create_position: 'an open',
  close_position: 'a close',
  adjust_margin: 'a margin change',
  set_tpsl: 'a TP/SL',
  place_limit_order: 'a limit or stop order',
  cancel_order: 'a cancel',
  claim_funding: 'a funding claim',
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function legOf(contracts: SignerContracts, to: string, selector: string): Leg | null {
  const s = selector.toLowerCase();
  const is = (target: string | null | undefined, sel: string) =>
    target != null && same(to, target) && s === sel;
  if (is(contracts.usdc, SELECTORS.approve)) return 'usdc-approve';
  if (is(contracts.usdc, SELECTORS.transfer)) return 'service-fee';
  if (is(contracts.weth, SELECTORS.approve)) return 'weth-approve';
  if (is(contracts.weth, SELECTORS.wethDeposit)) return 'weth-deposit';
  if (is(contracts.swapRouter02, SELECTORS.exactOutputSingle)) return 'keeper-fee-swap';
  if (is(contracts.gmx.exchangeRouter, SELECTORS.sendTokens)) return 'gmx-send-tokens';
  if (is(contracts.gmx.exchangeRouter, SELECTORS.createOrder)) return 'gmx-create-order';
  if (is(contracts.gmx.exchangeRouter, SELECTORS.cancelOrder)) return 'gmx-cancel-order';
  if (is(contracts.gmx.exchangeRouter, SELECTORS.claimFundingFees)) {
    return 'gmx-claim-funding-fees';
  }
  if (is(contracts.gmx.referralStorage, SELECTORS.setTraderReferralCodeByUser)) {
    return 'gmx-referral-code-sync';
  }
  return null;
}

type Call = { to: Address; value: bigint; data: Hex };

/** The account's calls: Kernel v3 `execute`, one call or a batch, nothing else. */
function callsOf(callData: Hex): Call[] {
  let mode: Hex;
  let execution: Hex;
  try {
    const decoded = decodeFunctionData({ abi: KERNEL_ABI, data: callData });
    [mode, execution] = decoded.args;
  } catch {
    throw new SignRefusal("its call data is not the account's execute of calls");
  }
  if (mode === MODE_BATCH) {
    try {
      const [executions] = decodeAbiParameters(EXECUTIONS, execution);
      return executions.map((e) => ({
        to: e.target.toLowerCase() as Address,
        value: e.value,
        data: e.callData,
      }));
    } catch {
      throw new SignRefusal('its batch of calls does not decode');
    }
  }
  if (mode === MODE_SINGLE && (execution.length - 2) / 2 >= 52) {
    return [
      {
        to: slice(execution, 0, 20).toLowerCase() as Address,
        value: BigInt(slice(execution, 20, 52)),
        data: slice(execution, 52),
      },
    ];
  }
  throw new SignRefusal(`it executes in a mode the tools never use (${mode.slice(0, 6)})`);
}

/** A call's arguments, or a refusal when they do not decode. */
function decoded<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new SignRefusal('a call of it does not decode');
  }
}

type Order = {
  market: string;
  isLong: boolean;
  orderType: number;
  sizeDeltaUsd: bigint;
  collateralDeltaAmount: bigint;
  triggerPrice: bigint;
  swapPath: readonly string[];
  initialCollateralToken: string;
  validFromTime: bigint;
};

function orderOf(data: Hex): Order {
  try {
    const p = decodeFunctionData({ abi: CREATE_ORDER_ABI, data }).args[0];
    return {
      market: p.addresses.market.toLowerCase(),
      isLong: p.isLong,
      orderType: p.orderType,
      sizeDeltaUsd: p.numbers.sizeDeltaUsd,
      collateralDeltaAmount: p.numbers.initialCollateralDeltaAmount,
      triggerPrice: p.numbers.triggerPrice,
      swapPath: p.addresses.swapPath.map((m) => m.toLowerCase()),
      initialCollateralToken: p.addresses.initialCollateralToken.toLowerCase(),
      validFromTime: p.numbers.validFromTime,
    };
  } catch {
    throw new SignRefusal('a GMX createOrder of it does not decode');
  }
}

const usd = (usd30: bigint) => `$${(Number(usd30 / 10n ** 26n) / 10_000).toLocaleString('en-US')}`;
/** A size of the request, collateral × leverage, USD with 30 decimals. */
const sizeAsked = (input: { collateralUsd: string; leverage: number }) =>
  (parseUnits(input.collateralUsd, 6) * BigInt(Math.round(input.leverage * 100)) * 10n ** 24n) /
  100n;
const sideOf = (isLong: boolean) => (isLong ? 'long' : 'short');

/** The market the request named, as the API resolved it, and what the Grant
 *  says of it. The Signer has no catalog: a request by ticker or id is held to
 *  the API's resolution, and that one to the Grant's markets when it names
 *  them (ticker and address). */
function marketOf(
  request: { market: { marketId: string } | { assetTicker: string } },
  stated: AgentOperationMarket | null,
  grant: GrantToCheck,
): AgentOperationMarket {
  if (stated === null) throw new SignRefusal('the API did not say which market it is for');
  const asked = request.market;
  if (
    'marketId' in asked
      ? asked.marketId !== stated.marketId
      : !same(asked.assetTicker, stated.assetTicker)
  ) {
    const name = 'marketId' in asked ? asked.marketId : asked.assetTicker;
    throw new SignRefusal(`it is for ${stated.assetTicker}, not the market asked (${name})`);
  }
  if (grant.markets !== 'any') {
    const entry = grant.markets.find((m) => same(m.gmxMarketAddress, stated.gmxMarketAddress));
    if (entry === undefined) {
      throw new SignRefusal(`its market ${stated.gmxMarketAddress} is not one of the Grant's`);
    }
    if (entry.assetTicker !== null && !same(entry.assetTicker, stated.assetTicker)) {
      throw new SignRefusal(
        `the Grant's market ${stated.gmxMarketAddress} is ${entry.assetTicker}, not ${stated.assetTicker}`,
      );
    }
  }
  return stated;
}

/** The GMX orders of the batch, held to the tool's request. */
function checkOrders(
  request: ToolRequest,
  orders: readonly Order[],
  cancels: readonly Hex[],
  step: SignStep,
  grant: GrantToCheck,
): void {
  const tool = TOOL_WORDS[request.action];
  const expectKinds = (kinds: readonly number[]) => {
    const got = orders.map((o) => o.orderType).sort();
    const want = [...kinds].sort();
    if (got.length !== want.length || got.some((kind, i) => kind !== want[i])) {
      const named = orders.map((o) => ORDER_TYPE_NAMES[o.orderType] ?? `order type ${o.orderType}`);
      throw new SignRefusal(
        `${tool} places ${want.map((k) => ORDER_TYPE_NAMES[k]).join(' and ') || 'no GMX order'}, but it places ${named.join(' and ') || 'none'}`,
      );
    }
  };
  const inMarket = (input: {
    market: { marketId: string } | { assetTicker: string };
    side: 'long' | 'short';
  }) => {
    const market = marketOf(input, step.market, grant);
    for (const order of orders) {
      if (!same(order.market, market.gmxMarketAddress)) {
        throw new SignRefusal(
          `an order is for market ${order.market}, not ${market.assetTicker} (${market.gmxMarketAddress})`,
        );
      }
      if (sideOf(order.isLong) !== input.side) {
        throw new SignRefusal(`an order is ${sideOf(order.isLong)}, not ${input.side}`);
      }
    }
  };
  switch (request.action) {
    case 'create_position': {
      const { input } = request;
      expectKinds([ORDER_TYPES.MarketIncrease]);
      inMarket(input);
      const asked = sizeAsked(input);
      const size = orders[0]?.sizeDeltaUsd ?? 0n;
      if (size > asked) {
        throw new SignRefusal(`its size is ${usd(size)}, more than the ${usd(asked)} asked`);
      }
      return;
    }
    case 'close_position':
      expectKinds([ORDER_TYPES.MarketDecrease]);
      inMarket(request.input);
      return;
    case 'adjust_margin': {
      const { input } = request;
      if (input.change === 'remove' && !grant.marginWithdrawalAllowed) {
        throw new SignRefusal(
          `removing margin needs the Grant setting "${MARGIN_WITHDRAWAL}", which is off`,
        );
      }
      expectKinds([
        input.change === 'add' ? ORDER_TYPES.MarketIncrease : ORDER_TYPES.MarketDecrease,
      ]);
      inMarket(input);
      if ((orders[0]?.sizeDeltaUsd ?? 0n) !== 0n) {
        throw new SignRefusal(`it changes the size by ${usd(orders[0]?.sizeDeltaUsd ?? 0n)}`);
      }
      return;
    }
    case 'set_tpsl': {
      const { input } = request;
      const kinds = [
        ...(input.takeProfitPriceUsd !== undefined ? [ORDER_TYPES.LimitDecrease] : []),
        ...(input.stopLossPriceUsd !== undefined ? [ORDER_TYPES.StopLossDecrease] : []),
      ];
      expectKinds(kinds);
      inMarket(input);
      // At most one order moved per TP or SL set; which ones the API reads.
      if (cancels.length > kinds.length) {
        throw new SignRefusal(`it cancels ${cancels.length} orders to set ${kinds.length}`);
      }
      // The kinds matched the prices asked, so each order has its price.
      for (const order of orders) {
        const takeProfit = order.orderType === ORDER_TYPES.LimitDecrease;
        const asked = takeProfit ? input.takeProfitPriceUsd : input.stopLossPriceUsd;
        checkTrigger(
          order,
          asked as string,
          step.market,
          takeProfit ? "its take profit's trigger" : "its stop loss's trigger",
        );
      }
      return;
    }
    case 'place_limit_order': {
      const { input } = request;
      if (!grant.pendingIncreaseOrdersAllowed) {
        throw new SignRefusal(
          `a limit or stop order needs the Grant setting "${PENDING_INCREASE_ORDERS}", which is off: the user turns it on by renewing the agent in the Denaria app (Renew)`,
        );
      }
      expectKinds([
        input.orderType === 'limit' ? ORDER_TYPES.LimitIncrease : ORDER_TYPES.StopIncrease,
      ]);
      inMarket(input);
      const order = orders[0] as Order;
      const asked = sizeAsked(input);
      if (order.sizeDeltaUsd > asked) {
        throw new SignRefusal(
          `its size is ${usd(order.sizeDeltaUsd)}, more than the ${usd(asked)} asked`,
        );
      }
      checkTrigger(order, input.triggerPriceUsd, step.market);
      checkReplaced(cancels, input.replacesOrderKey);
      return;
    }
    case 'cancel_order':
      expectKinds([]);
      if (cancels.length !== 1 || !same(cancels[0] ?? '', request.input.orderKey)) {
        throw new SignRefusal(
          `it cancels ${cancels.length === 1 ? `order ${cancels[0]}` : `${cancels.length} orders`}, not order ${request.input.orderKey}`,
        );
      }
      return;
    case 'claim_funding':
      expectKinds([]);
      return;
  }
}

/**
 * The order's GMX trigger is the price asked: GMX stores USD × 10^(30 − d)
 * for an index token of d decimals, which only the API's catalog knows, so the
 * step states d (ticket 19). One unit of slack for the division's rounding.
 */
function checkTrigger(
  order: Order,
  asked: string,
  market: AgentOperationMarket | null,
  what = 'its trigger',
): void {
  const decimals = market?.indexTokenDecimals;
  if (decimals === undefined) {
    throw new SignRefusal("the API did not say the decimals of the market's index token");
  }
  const scale = 10n ** BigInt(decimals);
  const want = parseUnits(asked, 30) / scale;
  const diff = order.triggerPrice > want ? order.triggerPrice - want : want - order.triggerPrice;
  if (diff > 1n) {
    throw new SignRefusal(
      `${what} is ${usd(order.triggerPrice * scale)}, not the ${usd(want * scale)} asked`,
    );
  }
}

/** A limit or stop order cancels nothing, or, to move one, exactly the order
 *  it replaces. */
function checkReplaced(cancels: readonly Hex[], replaced: string | undefined): void {
  const what =
    cancels.length === 0
      ? 'no order'
      : cancels.length === 1
        ? `order ${cancels[0]}`
        : `${cancels.length} orders`;
  if (replaced === undefined) {
    if (cancels.length > 0) {
      throw new SignRefusal(`it cancels ${what}, and no order was asked to be replaced`);
    }
  } else if (cancels.length !== 1 || !same(cancels[0] ?? '', replaced)) {
    throw new SignRefusal(`it cancels ${what}, not order ${replaced} it replaces`);
  }
}

const MARGIN_WITHDRAWAL = 'Margin withdrawal';
const PENDING_INCREASE_ORDERS = 'Pending limit and stop orders';
const DECREASE_ORDER_TYPES: readonly number[] = [
  ORDER_TYPES.MarketDecrease,
  ORDER_TYPES.LimitDecrease,
  ORDER_TYPES.StopLossDecrease,
];

/** Policy v5's rules on every order (ADR-0063 §2–§3, ADR-0065), whatever
 *  the tool: v4's, with one swap hop allowed, the chain's [USDC-USDG] market
 *  (what an order on a USDG pool carries), only on USDC paid in by an
 *  increase or USDG paid out by a decrease. */
function checkOrdersV5(
  request: ToolRequest,
  orders: readonly Order[],
  grant: GrantToCheck,
  contracts: SignerContracts,
): void {
  const tool = TOOL_WORDS[request.action];
  const hop = contracts.usdcUsdgSwapMarket;
  for (const order of orders) {
    const [first] = order.swapPath;
    const pinnedHop =
      order.swapPath.length === 1 && hop !== null && first !== undefined && same(first, hop);
    if (order.swapPath.length !== 0 && !pinnedHop) {
      throw new SignRefusal(
        `an order routes its collateral through ${order.swapPath.join(' → ')}, not the Grant's [USDC-USDG] swap market`,
      );
    }
    if (pinnedHop) {
      const increase = !DECREASE_ORDER_TYPES.includes(order.orderType);
      const converted = increase ? contracts.usdc : contracts.usdg;
      if (converted === null || !same(order.initialCollateralToken, converted)) {
        throw new SignRefusal(
          `an order swaps ${order.initialCollateralToken} through the [USDC-USDG] market, which converts only USDC paid in or USDG paid out`,
        );
      }
    }
    if (order.validFromTime !== 0n) {
      // No tool dates an order: a dated order outlives the Grant (ADR-0063
      // §3); a limit or stop order waits for its price, never for a date.
      throw new SignRefusal(
        grant.pendingIncreaseOrdersAllowed
          ? `an order is dated (valid from ${order.validFromTime}), which ${tool} never is`
          : `an order is dated (valid from ${order.validFromTime}), which needs the Grant setting "${PENDING_INCREASE_ORDERS}", which is off`,
      );
    }
    if (
      !grant.marginWithdrawalAllowed &&
      DECREASE_ORDER_TYPES.includes(order.orderType) &&
      order.collateralDeltaAmount !== 0n
    ) {
      throw new SignRefusal(
        `it takes collateral out of the position, which needs the Grant setting "${MARGIN_WITHDRAWAL}", which is off`,
      );
    }
  }
}

/** The spenders policy v4 pins for each token's `approve` (F9). */
function spendersOf(contracts: SignerContracts, leg: Leg): readonly Address[] {
  return leg === 'usdc-approve'
    ? [contracts.gmx.syntheticsRouter, contracts.swapRouter02]
    : [contracts.gmx.syntheticsRouter];
}

function userOpOf(json: AgentUserOp) {
  const big = (value: string | undefined) => (value === undefined ? undefined : BigInt(value));
  return {
    sender: json.sender as Address,
    nonce: BigInt(json.nonce),
    ...(json.factory !== undefined ? { factory: json.factory as Address } : {}),
    ...(json.factoryData !== undefined ? { factoryData: json.factoryData as Hex } : {}),
    callData: json.callData as Hex,
    callGasLimit: BigInt(json.callGasLimit),
    verificationGasLimit: BigInt(json.verificationGasLimit),
    preVerificationGas: BigInt(json.preVerificationGas),
    maxFeePerGas: BigInt(json.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(json.maxPriorityFeePerGas),
    ...(json.paymaster !== undefined ? { paymaster: json.paymaster as Address } : {}),
    ...(json.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: big(json.paymasterVerificationGasLimit) as bigint }
      : {}),
    ...(json.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: big(json.paymasterPostOpGasLimit) as bigint }
      : {}),
    ...(json.paymasterData !== undefined ? { paymasterData: json.paymasterData as Hex } : {}),
    signature: json.signature as Hex,
  };
}

/** The ERC-4337 v0.7 hash of the UserOp on `chainId`: what the Signer signs. */
export function userOpHashOf(userOp: AgentUserOp, chainId: number): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: '0.7',
    userOperation: userOpOf(userOp),
  });
}

/** The fields a second signature after a relay fault must keep: the next
 *  provider sponsors the same call data on the same nonce (ADR-0062 §13). */
const KEPT_ON_RETRY = ['sender', 'nonce', 'factory', 'factoryData', 'callData'] as const;

/**
 * The hash to sign for `step`, or a `SignRefusal` that says what did not
 * match. `first` is the UserOp this operation already had signed after it
 * passed this check (a relay fault asks for one more signature), null for the
 * first one.
 */
export function checkStepToSign(input: {
  request: ToolRequest;
  step: SignStep;
  chainId: number;
  contracts: SignerContracts;
  grant: GrantToCheck;
  first: { reference: string; userOp: AgentUserOp } | null;
}): Hex {
  const { request, step, contracts, grant, first } = input;
  const { userOp } = step;
  const hash = userOpHashOf(userOp, input.chainId);
  if (hash !== step.userOpHash.toLowerCase()) {
    throw new SignRefusal(
      `the hash the API stated (${step.userOpHash}) is not the hash of its UserOp on this chain (${hash})`,
    );
  }
  if (first !== null) {
    if (step.reference !== first.reference) {
      throw new SignRefusal(`it asks a signature for another operation (${step.reference})`);
    }
    const changed = KEPT_ON_RETRY.find((field) => first.userOp[field] !== userOp[field]);
    if (changed !== undefined) {
      throw new SignRefusal(
        `the UserOp to sign again changes its ${changed}: only gas and paymaster fields may change`,
      );
    }
    // The same sender, deployment and call data as the first UserOp, which
    // passed the whole check below: what it calls is unchanged, so the retry
    // is not held again to a market the API's retry step does not state.
    return hash;
  }
  if (!same(userOp.sender, grant.account)) {
    throw new SignRefusal(`it is for account ${userOp.sender}, not the Grant's ${grant.account}`);
  }
  if (userOp.factory !== undefined) throw new SignRefusal('it deploys an account');
  const allowed = legsOf(request);
  const tool = TOOL_WORDS[request.action];
  const orders: Order[] = [];
  const cancels: Hex[] = [];
  let wraps = 0;
  for (const call of callsOf(userOp.callData as Hex)) {
    const selector = call.data.slice(0, 10);
    const leg = legOf(contracts, call.to, selector);
    if (leg === null || !allowed.includes(leg)) {
      throw new SignRefusal(
        `it calls ${call.to} (selector ${selector}), which ${tool} never calls`,
      );
    }
    if (call.value !== 0n && leg !== 'weth-deposit') {
      throw new SignRefusal(`it sends ${call.value} wei of ETH to ${call.to}`);
    }
    if (leg === 'service-fee') {
      const [to] = decoded(() => decodeFunctionData({ abi: TRANSFER_ABI, data: call.data }).args);
      if (!same(to, contracts.serviceFeeReceiver)) {
        throw new SignRefusal(
          `it transfers USDC to ${to.toLowerCase()}, not the service fee receiver`,
        );
      }
    }
    if (leg === 'weth-deposit') wraps += 1;
    if (leg === 'usdc-approve' || leg === 'weth-approve') {
      const [spender] = decoded(
        () => decodeFunctionData({ abi: APPROVE_ABI, data: call.data }).args,
      );
      if (!spendersOf(contracts, leg).some((pinned) => same(spender, pinned))) {
        throw new SignRefusal(
          `it approves ${spender.toLowerCase()} to spend the account's ${leg === 'usdc-approve' ? 'USDC' : 'WETH'}`,
        );
      }
    }
    if (leg === 'gmx-create-order') orders.push(orderOf(call.data));
    if (leg === 'gmx-cancel-order') {
      cancels.push(
        decoded(() => decodeFunctionData({ abi: CANCEL_ORDER_ABI, data: call.data }).args[0]),
      );
    }
  }
  if (wraps > 1) throw new SignRefusal(`it wraps ETH ${wraps} times: at most once per operation`);
  checkOrders(request, orders, cancels, step, grant);
  checkOrdersV5(request, orders, grant, contracts);
  return hash;
}
