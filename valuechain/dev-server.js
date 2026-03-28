import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const port = 8788;

app.use(express.json());
app.use(express.static('.'));

let analyzer = null;

async function getAnalyzer() {
  if (!analyzer) {
    const { TopicAnalyzer } = await import('./functions/utils/analyzer.js');
    analyzer = new TopicAnalyzer();
  }
  return analyzer;
}

app.get('/api/suggestions', async (req, res) => {
  try {
    const q = req.query.q;
    const localAnalyzer = await getAnalyzer();
    const suggestions = localAnalyzer.getSuggestions(q);
    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/recommended-keywords', async (req, res) => {
  try {
    const localAnalyzer = await getAnalyzer();
    const categories = new Set();
    localAnalyzer.kb.forEach(item => {
      if (item) {
        if (item["대분류 (산업군)"]) categories.add(item["대분류 (산업군)"].trim());
        if (item["중분류 (섹터/테마)"]) categories.add(item["중분류 (섹터/테마)"].trim());
      }
    });
    
    const arr = Array.from(categories).filter(c => c && c.length > 0);
    
    // Randomize
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    
    res.json(arr.slice(0, 14)); // Return 14 keywords
  } catch (error) {
    console.error('Recommended keywords error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { constructGraph } = await import('./functions/utils/graph.js');
    const { keyword } = req.body;
    
    console.log(`Generating graph for: ${keyword}`);
    const localAnalyzer = await getAnalyzer();
    const analysis = localAnalyzer.generateFromKeyword(keyword);
    
    if (!analysis || !analysis.topics) {
        console.error("Analysis failed: Invalid structure returned from analyzer", analysis);
        throw new Error("Analysis failed: Invalid structure returned from analyzer");
    }

    const graphData = constructGraph(analysis, analysis.rootName || keyword);
    res.json(graphData);
  } catch (error) {
    console.error('Generation Error:', error);
    console.error(error.stack);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/expand-node', async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword) throw new Error("Keyword is required");
    
    // Remove bilingual parts if present
    const cleanKeyword = keyword.split(' | ')[0].trim();
    console.log(`Expanding leaf node via Web Search: ${cleanKeyword}`);
    
    // Using Wikipedia Opensearch/Search API as proxy for web search
    const searchUrl = `https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanKeyword)}&utf8=&format=json`;
    
    const response = await fetch(searchUrl);
    const data = await response.json();
    
    if (data.query && data.query.search) {
        // Filter out the exact keyword itself to ensure we get sub/related topics
        let subnodes = data.query.search
            .map(item => item.title)
            .filter(title => title.toLowerCase() !== cleanKeyword.toLowerCase())
            .slice(0, 4); // Take top 4 related concepts
            
        res.json({ subnodes });
    } else {
        res.json({ subnodes: [] });
    }
  } catch (error) {
    console.error('Expand Node Error:', error);
    res.status(500).json({ error: error.message, subnodes: [] });
  }
});

app.post('/api/smart-add-private', async (req, res) => {
  try {
    const { keyword, existingNodes } = req.body;
    if (!keyword) throw new Error("Keyword is required");
    
    const cleanKeyword = keyword.split(' | ')[0].trim();
    console.log(`Smart Add processing: ${cleanKeyword}`);
    
    // 1. If existing graph is empty, behave like expand-node
    if (!existingNodes || existingNodes.length === 0) {
        const searchUrl = `https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanKeyword)}&utf8=&format=json`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        if (data.query && data.query.search) {
            let subnodes = data.query.search
                .map(item => item.title)
                .filter(title => title.toLowerCase() !== cleanKeyword.toLowerCase())
                .slice(0, 4);
            return res.json({ newLines: subnodes.map(sub => `${cleanKeyword} -> ${sub.trim()}`) });
        }
        return res.json({ newLines: [`${cleanKeyword} -> `] });
    }

    // 2. Try KB Match
    const localAnalyzer = await getAnalyzer();
    const kbLines = localAnalyzer.findRelationships(cleanKeyword, existingNodes);
    if (kbLines.length > 0) {
        console.log(`Smart Add: Found KB match for ${cleanKeyword}:`, kbLines);
        return res.json({ newLines: kbLines });
    }

    // 3. Try Wikipedia Overlap Match
    const searchUrl = `https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanKeyword)}&utf8=&format=json`;
    const response = await fetch(searchUrl);
    const data = await response.json();
    
    let wikiResults = [];
    if (data.query && data.query.search) {
        wikiResults = data.query.search.map(item => item.title);
    }

    const matchedLines = [];
    let foundWikiMatch = false;

    for (const existingNode of existingNodes) {
        const cleanExisting = existingNode.split(' | ')[0].trim().toLowerCase();
        // Check if existing node matches any wiki result
        const isRelated = wikiResults.some(res => 
            res.toLowerCase().includes(cleanExisting) || cleanExisting.includes(res.toLowerCase())
        );
        if (isRelated) {
            matchedLines.push(`${existingNode.split(' | ')[0].trim()} -> ${cleanKeyword}`);
            foundWikiMatch = true;
        }
    }

    if (foundWikiMatch) {
         console.log(`Smart Add: Found Wiki overlap for ${cleanKeyword}:`, matchedLines);
         return res.json({ newLines: matchedLines });
    }

    // 4. Fallback: Bridging
    // Find a bridge topic, ensuring it isn't literally the exact keyword
    const bridgeTopicRaw = wikiResults.length > 0 ? wikiResults.find(r => r.toLowerCase() !== cleanKeyword.toLowerCase()) || wikiResults[0] : `${cleanKeyword} 관련도`;
    // Add a marker so the user knows it's a bridge
    const bridgeTopic = `${bridgeTopicRaw} (연결 브릿지)`;
    
    // Choose an anchor node from the existing graph. We'll pick the most connected or just the first one.
    const targetNode = existingNodes[0].split(' | ')[0].trim(); 
    const bridgeLines = [
        `${targetNode} -> ${bridgeTopic}`,
        `${bridgeTopic} -> ${cleanKeyword}`
    ];
    console.log(`Smart Add: Created Bridge for ${cleanKeyword}:`, bridgeLines);
    return res.json({ newLines: bridgeLines });

  } catch (error) {
    console.error('Smart Add Error:', error);
    res.status(500).json({ error: error.message, newLines: [] });
  }
});

app.post('/api/auto-connect', async (req, res) => {
  try {
    const { inputText } = req.body;
    if (!inputText) return res.json({ newText: '' });

    const lines = inputText.split('\n').filter(l => l.trim().length > 0);
    const nodes = new Set();
    const edges = new Set();

    lines.forEach(line => {
      const parts = line.split('->').map(p => p.trim());
      if (parts.length > 0 && parts[0]) nodes.add(parts[0]);
      if (parts.length > 1 && parts[1]) nodes.add(parts[1]);
      if (parts.length === 2 && parts[0] && parts[1]) {
        edges.add(`${parts[0]} -> ${parts[1]}`);
      }
    });

    const nodesArr = Array.from(nodes);
    let newLinks = [];

    for (let i = 0; i < nodesArr.length; i++) {
      for (let j = i + 1; j < nodesArr.length; j++) {
        const a = nodesArr[i];
        const b = nodesArr[j];
        
        if (edges.has(`${a} -> ${b}`) || edges.has(`${b} -> ${a}`)) continue;

        let shouldConnect = false;
        let p = a, c = b;

        if (a.includes(b) && a !== b) {
           shouldConnect = true; p = b; c = a; 
        } else if (b.includes(a) && b !== a) {
           shouldConnect = true; p = a; c = b; 
        } else {
           const tokensA = a.split(/[\s/()]+/).filter(t => t.length > 1);
           const tokensB = b.split(/[\s/()]+/).filter(t => t.length > 1);
           const overlap = tokensA.some(t => tokensB.includes(t));
           if (overlap) {
               shouldConnect = true; 
           }
        }

        if (shouldConnect) {
           newLinks.push(`${p} -> ${c}`);
           edges.add(`${p} -> ${c}`);
        }
      }
    }

    if (newLinks.length > 0) {
      const result = inputText + '\n\n' + newLinks.join('\n');
      res.json({ newText: result, connectedCount: newLinks.length });
    } else {
      res.json({ newText: inputText, connectedCount: 0 });
    }

  } catch (error) {
    console.error('Auto Connect Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl is required' });
    if (!sheetUrl.startsWith('http')) return res.status(400).json({ error: 'Invalid URL. Must start with http' });

    console.log(`Syncing with Google Sheets: ${sheetUrl}`);
    const { fetchSheetsData } = await import('./functions/utils/sheets.js');
    const newKB = await fetchSheetsData(sheetUrl);
    
    if (!newKB || Object.keys(newKB).length === 0) {
        throw new Error('No valid data found in the provided sheet. Check columns: Industry, Sector, Stock');
    }

    const localAnalyzer = await getAnalyzer();
    localAnalyzer.setKB(newKB);
    
    console.log(`Successfully synced with Google Sheets`);
    res.json({ message: 'Sync Successful', industries: Object.keys(newKB).length });
  } catch (error) {
    let friendlyMessage = error.message;
    if (friendlyMessage.includes('401') || friendlyMessage.includes('403')) {
      friendlyMessage = '접근 권한이 없습니다. 구글 시트의 [파일 > 공유 > 웹에 게시] 설정을 확인해주세요 (게시 여부 및 권한 설정).';
    }
    console.error('Sync Error:', friendlyMessage);
    res.status(500).json({ error: `Sync Failed: ${friendlyMessage}` });
  }
});

app.listen(port, () => {
    console.log(`🚀 NotebookLM Explorer: http://localhost:${port}`);
});
