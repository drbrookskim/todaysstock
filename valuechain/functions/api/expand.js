import { TopicAnalyzer } from '../utils/analyzer.js';

export async function onRequestPost({ request }) {
  try {
    const data = await request.json();
    const nodeId = data.nodeId;
    const label = data.label;

    if (!label) {
      return new Response(JSON.stringify({ error: "No label provided" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const analyzer = new TopicAnalyzer();
    const analysis = analyzer.generateFromKeyword(label);

    const nodes = [];
    const links = [];

    const topics = analysis.topics || {};
    const allKeywords = analysis.keywords || [];
    const topicEntries = Object.entries(topics);

    topicEntries.forEach(([topicName, data], i) => {
      const topicId = `${nodeId}_topic_${i}`;
      nodes.push({
        id: topicId,
        label: topicName,
        type: "topic",
        val: 2,
        description: `Expanded from '${label}'`
      });
      links.push({ source: nodeId, target: topicId });

      // Distribute keywords
      const keywordsPerTopic = 2;
      const startIdx = i * keywordsPerTopic;
      const topicKeywords = allKeywords.slice(startIdx, startIdx + keywordsPerTopic);

      topicKeywords.forEach(([word, score], kwIdx) => {
        const kwId = `${topicId}_kw_${kwIdx}`;
        nodes.push({
          id: kwId,
          label: word,
          type: "keyword",
          val: 0.5 + (score * 2),
          content: `### ${word}\n\nDeep expansion from '${label}'.`
        });
        links.push({ source: topicId, target: kwId });
      });
    });

    const stocks = analysis.stocks || [];
    stocks.forEach(([name, ticker], i) => {
      const stockId = `${nodeId}_stock_${i}`;
      nodes.push({
        id: stockId,
        label: `${name} (${ticker})`,
        type: "stock",
        ticker: ticker,
        val: 1.5,
        content: `### ${name} (${ticker})\n\nStock identified as relevant during expansion of **${label}**.\n\n[View Real-time Chart (External)](https://finance.yahoo.com/quote/${ticker})`
      });
      links.push({ source: nodeId, target: stockId });
    });

    return new Response(JSON.stringify({ nodes, links }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
