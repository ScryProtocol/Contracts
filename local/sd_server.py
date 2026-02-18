"""Minimal Stable Diffusion API server — AUTOMATIC1111-compatible endpoints.
Uses HuggingFace diffusers. Exposes /sdapi/v1/txt2img, /sdapi/v1/sd-models, /sdapi/v1/samplers.
"""
import argparse
import base64
import io
import json
import os
import random

import torch
torch.backends.cudnn.enabled = False  # cuDNN Bus Error on RTX 5090 Blackwell
from diffusers import StableDiffusionPipeline, EulerAncestralDiscreteScheduler, DPMSolverMultistepScheduler, DDIMScheduler
from flask import Flask, request, jsonify

app = Flask(__name__)

pipe = None
MODEL_PATH = None
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

SCHEDULERS = {
    'Euler a': EulerAncestralDiscreteScheduler,
    'DPM++ 2M Karras': DPMSolverMultistepScheduler,
    'DDIM': DDIMScheduler,
}


def load_pipe(model_path):
    global pipe, MODEL_PATH
    MODEL_PATH = model_path
    print(f'Loading model from {model_path}...')
    pipe = StableDiffusionPipeline.from_single_file(
        model_path,
        torch_dtype=torch.float16,
        use_safetensors=True,
    ).to(DEVICE)
    pipe.safety_checker = None
    pipe.requires_safety_checker = False
    print('Model loaded.')


@app.route('/sdapi/v1/sd-models')
def sd_models():
    name = os.path.basename(MODEL_PATH or 'unknown')
    return jsonify([{'title': name, 'model_name': name.replace('.safetensors', '')}])


@app.route('/sdapi/v1/samplers')
def sd_samplers():
    return jsonify([{'name': k} for k in SCHEDULERS])


@app.route('/sdapi/v1/options', methods=['GET', 'POST'])
def sd_options():
    return jsonify({})


@app.route('/sdapi/v1/txt2img', methods=['POST'])
def txt2img():
    data = request.get_json() or {}
    prompt = data.get('prompt', '')
    negative = data.get('negative_prompt', '')
    width = data.get('width', 512)
    height = data.get('height', 512)
    steps = data.get('steps', 20)
    cfg = data.get('cfg_scale', 7.0)
    seed = data.get('seed', -1)
    sampler_name = data.get('sampler_name', 'Euler a')

    if seed == -1:
        seed = random.randint(0, 2**32 - 1)

    try:
        # Set scheduler
        sched_cls = SCHEDULERS.get(sampler_name, EulerAncestralDiscreteScheduler)
        pipe.scheduler = sched_cls.from_config(pipe.scheduler.config)

        generator = torch.Generator(device=DEVICE).manual_seed(seed)

        with torch.no_grad():
            result = pipe(
                prompt=prompt,
                negative_prompt=negative if negative else None,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=cfg,
                generator=generator,
            )

        images_b64 = []
        for img in result.images:
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            images_b64.append(base64.b64encode(buf.getvalue()).decode())

        return jsonify({
            'images': images_b64,
            'parameters': data,
            'info': json.dumps({'seed': seed}),
        })
    except Exception as e:
        print(f'Error generating: {e}')
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='Path to .safetensors model')
    parser.add_argument('--port', type=int, default=7860)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()

    load_pipe(args.model)
    app.run(host=args.host, port=args.port)
