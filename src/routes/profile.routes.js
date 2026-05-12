import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { getProfile } from '../controllers/profileControllers.js';

const router = Router();


router.get('/me', requireAuth, getProfile);

export default router;
