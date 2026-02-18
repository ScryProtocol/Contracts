"""Recipes & Meal Prep app backend."""
import json
from flask import request, jsonify, Response, stream_with_context
from flask_login import login_required, current_user


def register(app, platform):

    @app.route('/api/apps/recipes/run', methods=['POST'])
    @login_required
    def run_recipes():
        data = request.get_json()
        ingredients = data.get('ingredients', '').strip()
        dietary = data.get('dietary', 'None')
        servings = int(data.get('servings', 4))
        meal_type = data.get('meal_type', 'Any')
        if not ingredients:
            return jsonify({'error': 'No ingredients'}), 400

        system = f'''You are a chef. Create a recipe using these ingredients: {ingredients}
Dietary: {dietary}. Servings: {servings}. Meal: {meal_type}.

Return ONLY JSON, no other text, no markdown fences:
{{"title": "Recipe Name", "prep_time": "10 min", "cook_time": "25 min", "servings": {servings}, "ingredients": ["1 cup rice", ...], "steps": ["Step 1...", ...], "tips": "Optional tips"}}'''
        messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': f'Make a recipe with: {ingredients}'}]

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
                start = text.find('{')
                end = text.rfind('}') + 1
                if start >= 0 and end > start:
                    recipe = json.loads(text[start:end])
                    yield platform.sse({'done': True, 'recipe': recipe})
                else:
                    yield platform.sse({'error': 'Could not parse recipe. Try again.'})
            except Exception as e:
                yield platform.sse({'error': str(e)})

        return Response(stream_with_context(generate()), mimetype='text/event-stream')
