-- Add artifact column to chat_messages for structured visualization specs
ALTER TABLE public.chat_messages ADD COLUMN artifact jsonb;
COMMENT ON COLUMN public.chat_messages.artifact IS 'Structured visualization spec (ArtifactSpec JSON)';
