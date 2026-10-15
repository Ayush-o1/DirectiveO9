import { z } from 'zod';

export const createOrderSchema = z
  .object({
    client_order_id: z.string().min(1).max(64).optional(),
    symbol: z.string().min(1).max(32),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['LIMIT', 'MARKET', 'IOC']),
    price: z.number().int().positive().optional(),
    quantity: z.number().int().positive(),
  })
  .refine(
    data => {
      if (data.type === 'LIMIT' || data.type === 'IOC') {
        return typeof data.price === 'number';
      }
      return true;
    },
    {
      message: 'Price is required for LIMIT and IOC orders',
      path: ['price'],
    }
  );

export const cancelOrderParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Order ID must be a numeric integer'),
});

export const cancelOrderBodySchema = z.object({
  symbol: z.string().min(1).max(32),
  client_order_id: z.string().min(1).max(64).optional(),
});

export const registerInstrumentSchema = z.object({
  symbol: z.string().min(1).max(32),
  tick_size: z.number().int().positive(),
  lot_size: z.number().int().positive(),
});

export const registerParticipantSchema = z.object({
  participant_id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  apiKey: z.string().min(16).max(128),
  is_admin: z.boolean().optional(),
});
