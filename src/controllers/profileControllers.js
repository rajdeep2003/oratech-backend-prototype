import { supabase } from '../database/supabaseClient.js';

/**
 * GET /api/profile/me
 * Protected — requires valid Bearer token via requireAuth middleware.
 * Returns the authenticated user's full profile from the profiles table.
 */
export const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.status(200).json({ profile });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
