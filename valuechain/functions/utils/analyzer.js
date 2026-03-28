import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TopicAnalyzer {
  constructor() {
    // Resolve KB path relative to this file's directory (functions/utils/ -> root)
    this.kbPath = path.resolve(__dirname, '../../knowledge_base.json');
    this.kb = JSON.parse(fs.readFileSync(this.kbPath, 'utf8'));
  }

  setKB(data) {
    this.kb = data;
  }

  generateFromKeyword(keyword) {
    const keywordLower = (keyword || 'Obsidian Graph View Style 기반 추가').toLowerCase();
    console.log(`Analyzing keyword: ${keywordLower}`);
    console.log(`KB Type: ${Array.isArray(this.kb) ? 'Array' : typeof this.kb}, Length: ${this.kb ? (this.kb.length || Object.keys(this.kb).length) : 'N/A'}`);
    
    // Default / Obsidian Case
    if (keywordLower === 'obsidian graph view style 기반 추가' || keywordLower === 'default' || keywordLower === 'ai' || keywordLower === 'ai반도체') {
      const rootName = keywordLower.includes('obsidian') ? 'Obsidian Graph View Style 기반 추가' : 'AI 반도체';
      const analysis = { topics: {}, rootName };
      
      if (!Array.isArray(this.kb)) {
          console.error("KB is not an array, cannot generate default view");
          return { topics: {}, rootName };
      }

      // Pick first 3 unique subcategories for the default view
      const subcategories = [...new Set(this.kb.filter(i => i).map(item => item["중분류 (섹터/테마)"]))].filter(Boolean).slice(0, 3);
      subcategories.forEach(sub => {
        const item = this.kb.find(i => i["중분류 (섹터/테마)"] === sub);
        analysis.topics[sub] = {
          keywords: (item["관련 종목"] || "").split(",").map(s => s.trim()).slice(0, 5)
        };
      });
      return analysis;
    }

    // Value Chain / All Case
    if (keywordLower.includes('value chain') || keywordLower.includes('밸류체인') || keywordLower === 'all') {
      const analysis = { topics: {}, rootName: 'Value Chain' };
      const mainCategories = [...new Set(this.kb.map(item => item["대분류 (산업군)"]))];
      mainCategories.forEach(cat => {
        const subForCat = this.kb.filter(item => item["대분류 (산업군)"] === cat);
        analysis.topics[cat] = {
          keywords: subForCat.map(item => item["중분류 (섹터/테마)"])
        };
      });
      return analysis;
    }

    // Search Matching
    const matchedItems = this.kb.filter(item => {
      if (!item) return false;
      const main = (item["대분류 (산업군)"] || "").toLowerCase();
      const sub = (item["중분류 (섹터/테마)"] || "").toLowerCase();
      const stocks = (item["관련 종목"] || "").toLowerCase();
      return main.includes(keywordLower) || sub.includes(keywordLower) || stocks.includes(keywordLower);
    });

    if (matchedItems.length === 0) {
      return {
        topics: { "General": { keywords: [`Insight into ${keyword}`] } },
        rootName: keyword
      };
    }

    // If multiple matches, group by the first match's main category
    const targetCat = matchedItems[0]["대분류 (산업군)"];
    const allInCat = this.kb.filter(item => item["대분류 (산업군)"] === targetCat);
    
    const analysis = { topics: {}, rootName: targetCat };
    allInCat.forEach(item => {
      analysis.topics[item["중분류 (섹터/테마)"]] = {
        keywords: item["관련 종목"].split(",").map(s => s.trim())
      };
    });
    
    return analysis;
  }

  getSuggestions(query) {
    if (!query || query.length < 1) return [];
    const q = query.toLowerCase();
    const suggestions = new Set();

    this.kb.forEach(item => {
      const main = item["대분류 (산업군)"] || "";
      const sub = item["중분류 (섹터/테마)"] || "";
      const stocks = (item["관련 종목"] || "").split(",").map(s => s.trim());

      if (main.toLowerCase().includes(q)) suggestions.add(main);
      if (sub.toLowerCase().includes(q)) suggestions.add(sub);
      stocks.forEach(s => {
        if (s.toLowerCase().includes(q)) suggestions.add(s);
      });
    });

    return Array.from(suggestions).slice(0, 10);
  }

  findRelationships(keyword, existingNodes) {
    if (!existingNodes || existingNodes.length === 0) return [];
    const k = keyword.toLowerCase();
    const newEdges = [];

    existingNodes.forEach(node => {
      const n = node.split(' | ')[0].trim().toLowerCase();
      
      // Is there any row in KB that contains BOTH the keyword and this existing node?
      const match = this.kb.find(item => {
        if (!item) return false;
        const main = (item["대분류 (산업군)"] || "").toLowerCase();
        const sub = (item["중분류 (섹터/테마)"] || "").toLowerCase();
        const stocks = (item["관련 종목"] || "").toLowerCase();
        
        const hasK = main.includes(k) || sub.includes(k) || stocks.includes(k);
        const hasN = main.includes(n) || sub.includes(n) || stocks.includes(n);
        
        return hasK && hasN;
      });

      if (match) {
        newEdges.push(`${node.split(' | ')[0].trim()} -> ${keyword}`);
      }
    });

    return Array.from(new Set(newEdges));
  }
}
