"""Translator app backend."""
import json
from flask import request, jsonify, Response, stream_with_context
from flask_login import login_required, current_user

LANGUAGES = [
    'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
    'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi', 'Russian',
    'Dutch', 'Swedish', 'Polish', 'Turkish', 'Vietnamese', 'Thai', 'Greek', 'Hebrew',
]


def register(app, platform):

    @app.route('/api/apps/translator/run', methods=['POST'])
    @login_required
    def run_translator():
        data = request.get_json()
        text = data.get('text', '').strip()
        source = data.get('source', 'Auto-detect')
        target = data.get('target', 'English')
        if not text:
            return jsonify({'error': 'No text'}), 400

        src = f'from {source} ' if source != 'Auto-detect' else ''
        system = f'You are a translator. Translate the following text {src}to {target}. Output ONLY the translation, no explanations or notes. Preserve formatting, tone, and meaning.'
        messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': text}]

        def generate():
            try:
                for token, done in platform.stream(messages, data):
                    if token:
                        yield platform.sse({'token': token})
                    if done:
                        break
                yield platform.sse({'done': True})
            except Exception as e:
                yield platform.sse({'error': str(e)})

        return Response(stream_with_context(generate()), mimetype='text/event-stream')


def get_template_context():
    return {'languages': LANGUAGES}
