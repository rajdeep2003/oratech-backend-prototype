import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import config from '../config/index.js';



const supabaseUrl = config.SUPABASE_URL;
const supabaseKey = config.SUPABASE_SERVICE_ROLE_KEY; // important

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase config missing — check env variables');
  }
export const supabase = createClient(supabaseUrl, supabaseKey);