import { z } from 'zod';

export const caip2EvmChainIdSchema = z
  .string()
  .max(40)
  .regex(/^eip155:[1-9][0-9]{0,31}$/, 'must be a canonical EVM CAIP-2 chain id');

export const envIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase Env name');

export const marketIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'must be a lowercase market UUID from denaria_get_markets',
  );

export const ethAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, 'must be a lowercase EthAddress');

export const boundedString = (max: number) => z.string().min(1).max(max);

export const isoTimestampSchema = z.iso.datetime();

/** A finite USD (or price) amount. JSON has no Infinity or NaN. */
export const usdNumberSchema = z.number().finite();
