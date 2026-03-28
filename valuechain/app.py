from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import json
from topic_analyzer import TopicAnalyzer
from export_graph_data import construct_graph

app = Flask(__name__, static_folder='.')
CORS(app)

analyzer = TopicAnalyzer(n_topics=5)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/graph_data.json')
def get_graph_data():
    return send_from_directory('.', 'graph_data.json')

@app.route('/api/generate', methods=['POST'])
def generate():
    data = request.json
    keyword = data.get('keyword')
    
    if not keyword:
        return jsonify({"error": "No keyword provided"}), 400
    
    print(f"API Request: Generate graph for '{keyword}'")
    
    # Generate analysis from keyword
    analysis = analyzer.generate_from_keyword(keyword)
    
    # Construct graph data
    graph_data = construct_graph(analysis, root_label=keyword)
    
    # Save to file for persistence (optional, but good for current UI logic)
    output_path = os.path.join(os.path.dirname(__file__), "graph_data.json")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(graph_data, f, indent=2)
        
    return jsonify(graph_data)

@app.route('/api/expand', methods=['POST'])
def expand():
    data = request.json
    node_id = data.get('nodeId')
    label = data.get('label')
    
    if not label:
        return jsonify({"error": "No label provided"}), 400
    
    print(f"API Request: Expand node '{label}' ({node_id})")
    
    # Generate analysis for the specific node label
    analysis = analyzer.generate_from_keyword(label)
    
    # Construct sub-graph
    # We prefix IDs with the parent node_id to ensure uniqueness in the global graph
    nodes = []
    links = []
    
    # We don't need a root node for expansion, we connect directly to the parent
    topics = analysis.get('topics', {})
    all_keywords = analysis.get('keywords', [])
    
    for i, (topic_name, data) in enumerate(topics.items()):
        topic_id = f"{node_id}_topic_{i}"
        nodes.append({
            "id": topic_id,
            "label": topic_name,
            "type": "topic",
            "val": 2, # Smaller than main topics
            "description": f"Expanded from '{label}'"
        })
        links.append({"source": node_id, "target": topic_id})
        
        # Distribute keywords
        keywords_per_topic = 2
        start_idx = i * keywords_per_topic
        topic_keywords = all_keywords[start_idx : start_idx + keywords_per_topic]
        
        for kw_idx, (word, score) in enumerate(topic_keywords):
            kw_id = f"{topic_id}_kw_{kw_idx}"
            
            nodes.append({
                "id": kw_id,
                "label": word,
                "type": "keyword",
                "val": 0.5 + (score * 2),
                "content": f"### {word}\n\nDeep expansion from '{label}'."
            })
            links.append({"source": topic_id, "target": kw_id})
            
    # Include stocks in expansion as well
    stocks = analysis.get('stocks', [])
    for i, (name, ticker) in enumerate(stocks):
        stock_id = f"{node_id}_stock_{i}"
        nodes.append({
            "id": stock_id,
            "label": f"{name} ({ticker})",
            "type": "stock",
            "ticker": ticker,
            "val": 1.5,
            "content": f"### {name} ({ticker})\n\nStock identified as relevant during expansion of **{label}**.\n\n[View Real-time Chart (External)](https://finance.yahoo.com/quote/{ticker})"
        })
        links.append({"source": node_id, "target": stock_id})
            
    return jsonify({"nodes": nodes, "links": links})

if __name__ == '__main__':
    # Using port 5200 as requested/previously used
    app.run(host='0.0.0.0', port=5200, debug=True)
