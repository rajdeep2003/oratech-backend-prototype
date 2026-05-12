import 'dotenv/config';
import app from './app.js';
import config from './config/index.js';
import { supabase } from './database/supabaseClient.js';

const PORT = config.port;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT} in ${config.environment} mode`);

  // 🔥 Supabase connection check
  try {
    const { error } = await supabase.from('test').select('*').limit(1);

    if (error) throw error;

    console.log('✅ Supabase connected successfully');
  } catch (err) {
    console.error('❌ Supabase connection failed:', err.message);
  }
});



