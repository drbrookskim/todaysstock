import json
import os
from conversation_parser import ConversationParser
from topic_analyzer import TopicAnalyzer

def construct_graph(analysis, root_label="Analysis Graph"):
    """
    Constructs nodes and links from an analysis object.
    """
    nodes = []
    links = []
    
    # Root node
    nodes.append({
        "id": "root",
        "label": root_label,
        "type": "root",
        "val": 4
    })
    
    # Topics and Keywords
    topics = analysis.get('topics', {})
    all_keywords = analysis.get('keywords', [])
    
    for i, (topic_name, data) in enumerate(topics.items()):
        topic_id = f"topic_{i}"
        nodes.append({
            "id": topic_id,
            "label": topic_name,
            "type": "topic",
            "val": 3,
            "description": f"This topic represents {data['percentage']:.1f}% of the analysis."
        })
        links.append({"source": "root", "target": topic_id})
        
        # Distribute top keywords among topics
        keywords_per_topic = 3
        start_idx = i * keywords_per_topic
        topic_keywords = all_keywords[start_idx : start_idx + keywords_per_topic]
        
        for kw_idx, (word, score) in enumerate(topic_keywords):
            kw_id = f"kw_{i}_{kw_idx}"
            
            generated_content = f"### {word.capitalize()}\n\n"
            generated_content += f"This keyword was identified with a relevance score of {score:.4f}.\n\n"
            generated_content += f"In the current context, **{word}** is a key theme. "
            generated_content += f"It relates closely to the topic '{topic_name}'.\n\n"
            generated_content += "#### Key Insights:\n"
            generated_content += f"- Relevant to thematic clusters.\n"
            generated_content += f"- Strong correlation with neighboring nodes.\n"
            generated_content += "- Actionable item: Explore more about this specific area."

            nodes.append({
                "id": kw_id,
                "label": word,
                "type": "keyword",
                "val": 1 + (score * 5),
                "content": generated_content
            })
            links.append({"source": topic_id, "target": kw_id})

    # Stock nodes
    stocks = analysis.get('stocks', [])
    for i, (name, ticker) in enumerate(stocks):
        stock_id = f"stock_{i}"
        nodes.append({
            "id": stock_id,
            "label": f"{name} ({ticker})",
            "type": "stock",
            "ticker": ticker,
            "val": 2.5,
            "content": f"### {name} ({ticker})\n\nThis stock is highly relevant to the main keyword **{root_label}**.\n\n#### Market Insights:\n- Sector: Technology/Core domain\n- Relevance: Direct investment opportunity related to '{root_label}'.\n\n[View Real-time Chart (External)](https://finance.yahoo.com/quote/{ticker})"
        })
        # Connect stocks to root as primary investment targets
        links.append({"source": "root", "target": stock_id})

    return {"nodes": nodes, "links": links}

def export_graph_data(input_file, output_file):
    print(f"Parsing {input_file}...")
    conversation = ConversationParser.parse(input_file)
    
    print("Analyzing topics and keywords...")
    analyzer = TopicAnalyzer(n_topics=5)
    analysis = analyzer.analyze_conversation(conversation)
    
    print("Constructing graph...")
    graph_data = construct_graph(analysis)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(graph_data, f, indent=2)
    
    print(f"Graph data exported to {output_file}")

if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(script_dir, "sample_conversations.json")
    output_path = os.path.join(script_dir, "graph_data.json")
    
    # Ensure sample data exists if requested
    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found. Please provide a conversation JSON file.")
    else:
        export_graph_data(input_path, output_path)
