-- 001_initial_schema.sql
-- Create the watchlist table for tracking user stocks
CREATE TABLE public.watchlist (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stock_code VARCHAR(20) NOT NULL,
    stock_name VARCHAR(100) NOT NULL,
    market VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate stock tracking per user
    UNIQUE(user_id, stock_code)
);

-- ============================================================================
-- STRICT ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- 1. Enable RLS on the table
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

-- 2. Select Policy: Users can only select their own watchlist items.
CREATE POLICY "Select own watchlist items" 
    ON public.watchlist 
    FOR SELECT 
    USING (auth.uid() = user_id);

-- 3. Insert Policy: Users can only insert items attached to their own auth.uid()
CREATE POLICY "Insert own watchlist items" 
    ON public.watchlist 
    FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

-- 4. Delete Policy: Users can only delete their own watchlist items
CREATE POLICY "Delete own watchlist items" 
    ON public.watchlist 
    FOR DELETE 
    USING (auth.uid() = user_id);

-- 5. Update Policy: Users can only update their own watchlist items
-- (Currently the application doesn't strictly update existing items, but for completeness)
CREATE POLICY "Update own watchlist items" 
    ON public.watchlist 
    FOR UPDATE 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
