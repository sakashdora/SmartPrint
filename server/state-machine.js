import { randomUUID } from 'node:crypto';

export const ORDER_STATUSES = [
  'created',
  'awaiting_payment',
  'queued',
  'printing',
  'awaiting_confirmation',
  'completed',
  'needs_review',
  'payment_review',
  'failed',
  'cancelled',
  'expired'
];

export const PERMITTED_TRANSITIONS = {
  created: ['awaiting_payment'],
  awaiting_payment: ['queued', 'payment_review', 'cancelled', 'expired'],
  queued: ['printing', 'cancelled'],
  printing: ['awaiting_confirmation', 'needs_review', 'failed'],
  awaiting_confirmation: ['completed', 'failed', 'needs_review'],
  needs_review: ['completed', 'failed', 'printing'],
  payment_review: ['queued', 'cancelled', 'failed'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  completed: [],
  expired: []
};

export const ROLE_TRANSITIONS = {
  customer: {
    created: ['awaiting_payment'],
    awaiting_payment: ['cancelled']
  },
  owner: {
    awaiting_payment: ['queued', 'cancelled'],
    queued: ['printing', 'cancelled'],
    printing: ['completed', 'failed'],
    awaiting_confirmation: ['completed', 'failed'],
    needs_review: ['completed', 'failed'],
    payment_review: ['queued', 'cancelled'],
    failed: ['queued', 'cancelled']
  },
  device: {
    queued: ['printing'],
    printing: ['awaiting_confirmation', 'needs_review', 'failed']
  },
  system: {
    awaiting_payment: ['queued', 'payment_review', 'expired'],
    printing: ['needs_review']
  },
  admin: {
    failed: ['queued', 'cancelled'],
    needs_review: ['completed', 'failed']
  }
};

export function canTransition(fromStatus, toStatus, role = 'system') {
  const allowed = PERMITTED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) return false;
  if (role === 'system') return true;
  const roleAllowed = ROLE_TRANSITIONS[role]?.[fromStatus];
  return Boolean(roleAllowed && roleAllowed.includes(toStatus));
}

const now = () => new Date().toISOString();

export async function transitionOrder(tx, orderId, toStatus, {
  actor = 'system',
  action = 'status_update',
  detail = '',
  requiredPayment = null,
  setPayment = null,
  additionalSets = '',
  additionalParams = []
} = {}) {
  const [current] = await tx.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  if (!current) {
    const err = new Error('Order not found.');
    err.status = 404;
    throw err;
  }

  // Idempotent short-circuit if already in target status and payment matches
  if (current.status === toStatus && (!setPayment || current.payment === setPayment)) {
    return current;
  }

  const allowed = PERMITTED_TRANSITIONS[current.status] || [];
  if (!allowed.includes(toStatus)) {
    const err = new Error(`Cannot transition order from '${current.status}' to '${toStatus}'.`);
    err.status = 409;
    throw err;
  }

  if (requiredPayment && current.payment !== requiredPayment) {
    const err = new Error(`Order payment must be '${requiredPayment}' (currently '${current.payment}').`);
    err.status = 409;
    throw err;
  }

  const paymentValue = setPayment || current.payment;
  const setClauses = ['status=$2', 'payment=$3'];
  const params = [orderId, toStatus, paymentValue];

  if (toStatus === 'completed' || toStatus === 'cancelled' || toStatus === 'expired') {
    setClauses.push(`deleted_at=$${params.length + 1}`);
    params.push(now());
  }

  if (additionalSets) {
    setClauses.push(additionalSets);
    params.push(...additionalParams);
  }

  const updateSql = `UPDATE orders SET ${setClauses.join(', ')} WHERE id=$1 RETURNING *`;
  const [updated] = await tx.query(updateSql, params);
  if (!updated) {
    const err = new Error('Failed to update order state.');
    err.status = 409;
    throw err;
  }

  const historyId = randomUUID();
  try {
    await tx.query('SAVEPOINT state_machine_hist_sp');
    await tx.query(
      'INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [historyId, orderId, current.status, toStatus, String(actor).slice(0, 100), String(action).slice(0, 100), String(detail || '').slice(0, 255), now()]
    );
    await tx.query('RELEASE SAVEPOINT state_machine_hist_sp');
  } catch (histErr) {
    await tx.query('ROLLBACK TO SAVEPOINT state_machine_hist_sp').catch(() => {});
    console.warn('[SmartPrint StateMachine] Non-critical order_history insert failed in transitionOrder:', histErr.message);
  }

  return updated;
}
