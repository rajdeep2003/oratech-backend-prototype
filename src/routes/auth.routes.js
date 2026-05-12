import { Router } from 'express';
import { signup, login, bulkSignup } from '../controllers/authControllers.js';

const router = Router();

// const authLimiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 10,                   // max 10 attempts per window
//     message: { error: "Too many attempts. Please try again later." },
//     standardHeaders: true,
//     legacyHeaders: false,
//   });

router.post('/signup', signup);
router.post('/login', login);
router.post('/bulk-signup', bulkSignup); //dev route


export default router;