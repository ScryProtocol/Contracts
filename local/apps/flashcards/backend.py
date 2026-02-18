"""Flashcards app backend."""
import json
from flask import request, jsonify, Response, stream_with_context
from flask_login import login_required, current_user


def register(app, platform):

    @app.route('/api/apps/flashcards/run', methods=['POST'])
    @login_required
    def run_flashcards():
        data = request.get_json()
        topic = data.get('topic', '').strip()
        count = min(int(data.get('count', 10)), 30)
        if not topic:
            return jsonify({'error': 'No topic'}), 400

        system = f'Generate exactly {count} flashcards about: {topic}\n\nReturn ONLY a JSON array, no other text, no markdown fences:\n[{{"front": "Question", "back": "Answer"}}, ...]'
        messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': f'Generate {count} flashcards about: {topic}'}]

        def generate():
            try:
                full = []
                for token, done in platform.stream(messages, data):
                    if token:
                        full.append(token)
                        yield platform.sse({'token': token})
                    if done:
                        break
                text = ''.join(full).strip()
                start = text.find('[')
                end = text.rfind(']') + 1
                if start >= 0 and end > start:
                    cards = json.loads(text[start:end])
                    yield platform.sse({'done': True, 'cards': cards})
                else:
                    yield platform.sse({'error': 'Could not parse flashcards. Try again.'})
            except Exception as e:
                yield platform.sse({'error': str(e)})

        return Response(stream_with_context(generate()), mimetype='text/event-stream')
