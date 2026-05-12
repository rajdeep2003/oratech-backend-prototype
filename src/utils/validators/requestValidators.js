import { body, validationResult } from 'express-validator';

/**
 * Validate email format
 */
export const validateEmail = body('email')
  .isEmail()
  .normalizeEmail()
  .withMessage('Valid email is required');

/**
 * Validate password strength
 */
export const validatePassword = body('password')
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters')
  .matches(/[A-Z]/)
  .withMessage('Password must contain uppercase letter')
  .matches(/[0-9]/)
  .withMessage('Password must contain number')
  .matches(/[!@#$%^&*]/)
  .withMessage('Password must contain special character');

/**
 * Validate required fields
 */
export const validateRequired = (fields) => {
  return fields.map((field) =>
    body(field).notEmpty().withMessage(`${field} is required`)
  );
};

/**
 * Middleware to handle validation errors
 */
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      errors: errors.array(),
    });
  }

  next();
};