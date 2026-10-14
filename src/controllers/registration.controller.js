import {
  createRegistration,
  getRegistrationStatus,
  retryPayment
} from '../services/registration.js';

export async function createRegistrationHandler(req, res, next) {
  try {
    const result = await createRegistration(req.body);
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
