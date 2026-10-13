// Dashboard settings.
// Leave supabaseUrl blank to run in demo mode with a simulated kiln.
// The anon/publishable key is safe to publish: the database rules only allow viewing.
window.KILN_CONFIG = {
  supabaseUrl: '',          // e.g. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',      // Supabase → Project Settings → API Keys
  deviceId: 'gas-kiln',     // must match DEVICE_ID in the firmware
  kilnName: 'Gas Kiln',
};
