import collections
import re

class TopicAnalyzer:
    def __init__(self, n_topics=5):
        self.n_topics = n_topics

    def analyze_conversation(self, conversation):
        """
        Analyzes a list of messages to extract topics and keywords using word frequency.
        This version is robust and avoids heavy dependencies that might hang during import.
        """
        # Extract text from messages
        print(f"Analyzing {len(conversation)} messages...")
        texts = []
        for msg in conversation:
            if isinstance(msg, dict):
                text = msg.get('text', msg.get('content', ''))
            else:
                text = str(msg)
            if text:
                texts.append(text.lower())

        if not texts:
            print("No text found in conversation.")
            return {"topics": {}, "keywords": []}

        # Simple stop words
        stop_words = set([
            'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', "you're", "you've", "you'll", "you'd",
            'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', "she's", 'her', 'hers',
            'herself', 'it', "it's", 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
            'who', 'whom', 'this', 'that', "that'll", 'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been',
            'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
            'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
            'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out',
            'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
            'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
            'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', "don't",
            'should', "should've", 'now', 'd', 'll', 'm', 'o', 're', 've', 'y', 'ain', 'aren', "aren't", 'couldn',
            "couldn't", 'didn', "didn't", 'doesn', "doesn't", 'hadn', "hadn't", 'hasn', "hasn't", 'haven', "haven't",
            'isn', "isn't", 'ma', 'mightn', "mightn't", 'mustn', "mustn't", 'needn', "needn't", 'shan', "shan't",
            'shouldn', "shouldn't", 'wasn', "wasn't", 'weren', "weren't", 'won', "won't", 'wouldn', "wouldn't"
        ])

        # Tokenize and count words
        print("Tokenizing and counting words...")
        words = []
        for text in texts:
            # Simple word extraction
            tokens = re.findall(r'\b\w{3,}\b', text)
            words.extend([w for w in tokens if w not in stop_words])

        if not words:
            return {"topics": {"General": {"percentage": 100.0, "message_count": len(texts)}}, "keywords": []}

        word_counts = collections.Counter(words)
        top_words = word_counts.most_common(20)
        
        # Group top words into "topics" for UI structure
        analysis = {"topics": {}, "keywords": []}
        
        # Mocking 5 topics based on top keywords
        for i in range(min(self.n_topics, len(top_words)//3)):
            start_idx = i * 3
            topic_keywords = [top_words[j][0] for j in range(start_idx, min(start_idx + 3, len(top_words)))]
            topic_name = " & ".join(topic_keywords)
            
            # Simple heuristic for percentage and count
            percentage = 100 / self.n_topics
            message_count = len(texts) // self.n_topics
            
            analysis["topics"][topic_name] = {
                "percentage": float(percentage),
                "message_count": int(message_count)
            }
            
            # Add top keywords to the list
            for word, count in top_words[start_idx : start_idx + 3]:
                score = count / len(words)
                analysis["keywords"].append((word, score))

        print("Topic analysis complete.")
        return analysis

    def generate_from_keyword(self, keyword):
        """
        Generates a knowledge graph (topics and keywords) based on a single input keyword.
        """
        print(f"Generating knowledge graph for: {keyword}")
        
        # Simple rule-based expansion based on the keyword category
        # In a real app, this would call an LLM API
        
        # Defining some 'expert' knowledge for common domains
        knowledge_base = {
            "ai": ["Machine Learning", "Neural Networks", "Natural Language Processing", "Robotics", "Ethics"],
            "space": ["Planets", "Galaxies", "Black Holes", "Rocketry", "Astronomy"],
            "cooking": ["Recipes", "Techniques", "Ingredients", "Nutrition", "World Cuisines"],
            "coding": ["Frontend", "Backend", "DevOps", "Data Science", "Mobile Development"],
            "ev": ["Battery Technology", "Charging Infrastructure", "Autonomous Driving", "Electric Motors"]
        }
        
        # Ticker mapping for domains
        ticker_map = {
            "ai": [("NVIDIA", "NVDA"), ("Microsoft", "MSFT"), ("Alphabet", "GOOGL"), ("AMD", "AMD"), ("Palantir", "PLTR")],
            "space": [("SpaceX", "PRIVATE"), ("Virgin Galactic", "SPCE"), ("Rocket Lab", "RKLB"), ("Boeing", "BA"), ("Lockheed Martin", "LMT")],
            "cooking": [("Blue Apron", "APRN"), ("HelloFresh", "HELLY"), ("Tyson Foods", "TSN"), ("Nestle", "NSRGY")],
            "coding": [("GitHub (MSFT)", "MSFT"), ("GitLab", "GTLB"), ("Atlassian", "TEAM"), ("Snowflake", "SNOW")],
            "ev": [("Tesla", "TSLA"), ("Rivian", "RIVN"), ("Lucid", "LCID"), ("NIO", "NIO"), ("BYD", "BYDDY")]
        }
        
        import random
        
        # Find closest match or generic expansion
        keyword_lower = keyword.lower()
        related_topics = []
        for key, topics in knowledge_base.items():
            if key in keyword_lower:
                # Use a subset of topics and add some random variation
                count = random.randint(3, 5)
                related_topics = random.sample(topics, min(len(topics), count))
                break
        
        if not related_topics:
            # Generic expansion if no match found
            base_topics = ["Impact", "Trends", "Tools", "Future", "Community", "Research", "Education"]
            count = random.randint(3, 4)
            related_topics = [f"{keyword} {t}" for t in random.sample(base_topics, count)]

        analysis = {"topics": {}, "keywords": [], "stocks": []}
        
        # Identify domain for stocks
        domain = None
        for key in ticker_map.keys():
            if key in keyword_lower:
                domain = key
                break
        
        if domain:
            # Pick 2-3 random stocks from the domain
            analysis["stocks"] = random.sample(ticker_map[domain], random.randint(2, 3))

        for i, topic_name in enumerate(related_topics):
            analysis["topics"][topic_name] = {
                "percentage": 100 / len(related_topics),
                "message_count": 1 
            }
            
            # Generate 2-3 keywords for each topic
            for j in range(random.randint(2, 3)):
                variations = ["Core", "Advanced", "History", "Best Practice", "Framework", "System"]
                kw_word = f"{topic_name.split()[0]} {random.choice(variations)}"
                score = random.uniform(0.1, 0.4)
                analysis["keywords"].append((kw_word, score))
                
        return analysis
