import {
  createRegistration,
  getRegistrationStatus,
  retryPayment
} from '../services/registration.js';

export async function createRegistrationHandler(req, res, next) {
  try {
    const idempotencyKey =
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      req.body?.idempotencyKey;
    const result = await createRegistration({
      ...req.body,
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    res.status(201).json({
      success: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
}

export async function getRegistrationStatusHandler(req, res, next) {
  try {
    const { reference } = req.params;
    const result = await getRegistrationStatus(reference);
    res.json({
      success: true,
      registration: result
    });
  } catch (err) {
    next(err);
  }
}

export async function retryPaymentHandler(req, res, next) {
  try {
    const { reference } = req.params;
    const result = await retryPayment(reference);
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
}

export async function applyCouponHandler(req, res, next) {
  try {
    const { reference } = req.params;
    const { couponCode } = req.body || {};
    if (!couponCode) {
      return res.status(400).json({
        success: false,
        code: 'COUPON_VALIDATION_FAILED',
        error: 'Coupon code is required.'
      });
    }

    const { applyCouponToRegistration } = await import('../services/registration.js');
    const result = await applyCouponToRegistration(reference, couponCode);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function removeCouponHandler(req, res, next) {
  try {
    const { reference } = req.params;
    const { removeCouponFromRegistration } = await import('../services/registration.js');
    const result = await removeCouponFromRegistration(reference);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getInvitationHandler(req, res, next) {
  try {
    const { token } = req.params;
    const { getInvitationByToken } = await import('../services/registration.js');
    const result = await getInvitationByToken(token);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function createInvitationOrderHandler(req, res, next) {
  try {
    const { token } = req.params;
    const { createInvitationCheckoutOrder } = await import('../services/registration.js');
    const result = await createInvitationCheckoutOrder(token);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function applyInvitationCouponHandler(req, res, next) {
  try {
    const { token } = req.params;
    const { couponCode } = req.body;
    const { applyCouponToInvitation } = await import('../services/registration.js');
    const result = await applyCouponToInvitation(token, couponCode);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function removeInvitationCouponHandler(req, res, next) {
  try {
    const { token } = req.params;
    const { removeCouponFromInvitation } = await import('../services/registration.js');
    const result = await removeCouponFromInvitation(token);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function createApplicationHandler(req, res, next) {
  try {
    const idempotencyKey =
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      req.body?.idempotencyKey;
    const { createApplication } = await import('../services/registration.js');
    const result = await createApplication({
      ...req.body,
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    res.status(201).json({
      success: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
}


