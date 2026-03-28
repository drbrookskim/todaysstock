/**
 * Parses a Published Google Sheet CSV into the knowledge_base format.
 * @param {string} url - The Public CSV URL
 */
export async function fetchSheetsData(url) {
    try {
        // Simple validation of URL
        if (!url.includes('spreadsheets') || !url.includes('output=csv')) {
            console.warn('URL might not be a published CSV URL');
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const csvText = await response.text();
        
        // Validation: If the response looks like HTML/JS, it's the wrong URL
        if (csvText.includes('<!DOCTYPE html>') || csvText.includes('<script') || csvText.includes('var d=this||self')) {
            throw new Error('올바른 CSV 주소가 아닙니다. 구글 시트에서 [파일 > 공유 > 웹에 게시 > CSV]로 생성된 주소를 입력해주세요.');
        }
        
        // Handle both CRLF and LF
        const lines = csvText.replace(/\r/g, '').split('\n');
        const kb = {};

        if (lines.length < 2) throw new Error('CSV is empty or invalid format');

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Proper CSV regex to handle commas inside quotes
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(p => p.trim().replace(/^"|"$/g, ''));
            
            // Expected columns: Industry, Sector/Theme, Stock
            if (parts.length < 3) {
                console.warn(`Skipping incomplete line ${i+1}: ${line}`);
                continue;
            }

            const [industry, sector, stock] = parts;
            // Create a stable ID for the industry
            const industryId = industry.trim()
                .replace(/[^a-zA-Z0-9가-힣\s]/g, '')
                .replace(/\s+/g, '_')
                .toLowerCase();

            if (!kb[industryId]) {
                kb[industryId] = {
                    topic: industry,
                    alias: [industry],
                    subtopics: {}
                };
            }

            if (!kb[industryId].subtopics[sector]) {
                kb[industryId].subtopics[sector] = [];
            }

            // Split stocks if multiple are provided in one cell (separated by comma or newline)
            const stockItems = stock.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
            stockItems.forEach(item => {
                if (!kb[industryId].subtopics[sector].includes(item)) {
                    kb[industryId].subtopics[sector].push(item);
                }
            });
        }

        if (Object.keys(kb).length === 0) throw new Error('No valid data found in CSV');
        return kb;
    } catch (error) {
        console.error('Error in fetchSheetsData:', error);
        throw error;
    }
}
