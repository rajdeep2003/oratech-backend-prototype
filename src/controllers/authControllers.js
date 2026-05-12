import { supabase } from '../database/supabaseClient.js';

export const signup = async (req, res) => {
  try {
    const { email, password, username, user_id } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1. Create auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const authUserId = data.user.id;

    // 2. Insert into profiles
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: authUserId,       // 🔗 FK → auth.users.id
        username,
        email,
        user_id: user_id || null,  // ✅ optional
      });

    // 3. Rollback if profile fails
    if (profileError) {
      await supabase.auth.admin.deleteUser(authUserId);
      return res.status(500).json({ error: "Profile creation failed" });
    }

    return res.status(201).json({
      message: "User created successfully",
      user_id: authUserId,
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
};


export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const accessToken = data.session.access_token;
    const refreshToken = data.session.refresh_token;
    const userId = data.user.id;

    // 🔥 Fetch profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileError) {
      return res.status(500).json({ error: "Profile not found" });
    }

    // 🍪 Cookie (web)
    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000,
    });

    return res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      user: profile, // ✅ now frontend gets full user data
    });

  } catch (err) {
    return res.status(500).json({
      error: "Internal server error",
    });
  }
};




export const bulkSignup = async (req, res) => {
  const { users } = req.body;

  if (!users || !Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: "Users array required" });
  }

  const results = [];

  for (const user of users) {
    const { email, password, username, user_id } = user;

    if (!email || !password || !username) {
      results.push({
        email,
        status: "failed",
        error: "Missing fields",
      });
      continue;
    }

    try {
      // 1. Create auth user
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (error) {
        results.push({
          email,
          status: "failed",
          error: error.message,
        });
        continue;
      }

      const authUserId = data.user.id;

      // 2. Insert profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authUserId,
          username,
          email,
          user_id: user_id || null,
        });

      if (profileError) {
        // rollback
        await supabase.auth.admin.deleteUser(authUserId);

        results.push({
          email,
          status: "failed",
          error: "Profile creation failed",
        });
        continue;
      }

      results.push({
        email,
        status: "success",
        user_id: authUserId,
      });

    } catch (err) {
      results.push({
        email,
        status: "failed",
        error: err.message,
      });
    }
  }

  return res.status(200).json({
    total: users.length,
    results,
  });
};