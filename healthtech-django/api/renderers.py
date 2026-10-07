from rest_framework.renderers import JSONRenderer


class EnvelopeJSONRenderer(JSONRenderer):
    """
    Formato JSON estandarizado para TODA la API.

    Éxito:  {"ok": true,  "status": 200, "data": ...}
    Error:  {"ok": false, "status": 400, "error": {"code", "message", "details"}}
    (los errores los arma api.exceptions.custom_exception_handler)
    """

    def render(self, data, accepted_media_type=None, renderer_context=None):
        response = (renderer_context or {}).get('response')
        ya_envuelto = isinstance(data, dict) and 'ok' in data and 'status' in data
        if response is not None and not ya_envuelto:
            codigo = response.status_code
            if codigo < 400:
                data = {'ok': True, 'status': codigo, 'data': data}
            else:
                data = {'ok': False, 'status': codigo,
                        'error': {'code': 'error', 'message': 'Error en la solicitud.', 'details': data}}
        return super().render(data, accepted_media_type, renderer_context)
