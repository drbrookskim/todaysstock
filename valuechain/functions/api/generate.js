import { TopicAnalyzer } from '../utils/analyzer.js';
import { constructGraph } from '../utils/graph.js';

export async function onRequestPost({ request }) {
  try {
    const data = await request.json();
    const keyword = data.keyword;

    if (!keyword) {
      return new Response(JSON.stringify({ error: "No keyword provided" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const analyzer = new TopicAnalyzer();
    const analysis = analyzer.generateFromKeyword(keyword);
    const graphData = constructGraph(analysis, keyword);

    return new Response(JSON.stringify(graphData), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
