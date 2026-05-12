// routes/index.js

import { Router } from 'express';
import authRoutes from './auth.routes.js';
import profileRoutes from './profile.routes.js';
import directMetrixRoutes from './directMetrix.routes.js';
// import userRoutes from './user.routes.js';

const router = Router();

// mount routes
router.use('/auth', authRoutes);
router.use('/profile', profileRoutes);
router.use('/metrics', directMetrixRoutes);

export default router;