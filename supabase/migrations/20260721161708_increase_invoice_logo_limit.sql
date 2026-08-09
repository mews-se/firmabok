-- Allow larger company logos while keeping the upload route and storage limit
-- aligned at 10 MB. Existing files and public access remain unchanged.

UPDATE storage.buckets
SET file_size_limit = 10485760
WHERE id = 'logos';

NOTIFY pgrst, 'reload schema';
