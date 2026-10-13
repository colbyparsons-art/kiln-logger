// Dashboard settings.
// Leave supabaseUrl blank to run in demo mode with a simulated kiln.
// The anon/publishable key is safe to publish: the database rules only allow viewing.
window.KILN_CONFIG = {
  supabaseUrl: 'https://ojhgtfrxqzkympprqlsm.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qaGd0ZnJ4cXpreW1wcHJxbHNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4ODcyOTEsImV4cCI6MjEwNzQ2MzI5MX0.iZgaQ4Y7Jk3WxCZZO80wMdAA66QFpCn6c49Mw9_YlWQ',
  deviceId: 'gas-kiln',     // must match DEVICE_ID in the firmware
  kilnName: 'Gas Kiln',
};
