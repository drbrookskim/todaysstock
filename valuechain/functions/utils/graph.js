export function constructGraph(analysis, rootLabel = "Analysis") {
  const nodes = [{ id: "root", label: rootLabel, type: "root", val: 10 }];
  const links = [];

  Object.entries(analysis.topics).forEach(([topicName, data], i) => {
    const topicId = `topic_${i}`;
    nodes.push({ id: topicId, label: topicName, type: "topic", val: 6 });
    links.push({ source: "root", target: topicId });

    const topicKeywords = data.keywords || [];

    topicKeywords.forEach((word, kwIdx) => {
      const kwId = `stock_${i}_${kwIdx}`;
      nodes.push({ 
        id: kwId, 
        label: word, 
        type: "stock", 
        val: 4, 
        content: `### ${word}\n\nThis is a related stock/company in the ${topicName} sector of the ${rootLabel} value chain.` 
      });
      links.push({ source: topicId, target: kwId });
    });
  });

  return { nodes, links };
}
