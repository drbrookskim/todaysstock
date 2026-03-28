import json
import os

class ConversationParser:
    @staticmethod
    def parse(file_path):
        """
        Parses a JSON file containing a conversation.
        Expected format: A list of message objects or a dictionary with a 'messages' key.
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Conversation file not found: {file_path}")
            
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        # Handle different potential JSON structures
        if isinstance(data, list):
            return data
        elif isinstance(data, dict) and 'messages' in data:
            return data['messages']
        else:
            # Fallback for simple dict
            return [data]
