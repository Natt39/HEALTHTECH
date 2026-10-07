"""
Pruebas automáticas de la API HealthTech TACO.
Ejecutar:  python manage.py test
"""
from datetime import timedelta
from io import BytesIO
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image
from rest_framework.test import APITestCase

from .ia import IAConfigError, IAResponseError
from .models import Medicamento, PerfilUsuario, RegistroINR, RegistroToma

BASE = '/api/v1'
CLAVE = 'Clave-Segura-2026!'
SEMANA = {'lunes': '1', 'martes': '1/2', 'miercoles': '1', 'jueves': '1+1/4',
          'viernes': '1', 'sabado': '', 'domingo': ''}


def crear_usuario(email, rol='paciente', **extra):
    user = User.objects.create_user(username=email, email=email, password=CLAVE,
                                    first_name=email.split('@')[0], **extra)
    if rol != 'paciente':
        PerfilUsuario.objects.filter(usuario=user).update(rol=rol)
    return User.objects.get(pk=user.pk)


def medicamento_payload(**cambios):
    datos = {'nombre': 'Neosintrom', 'unidadPastilla': '4 mg', 'horaProgramada': '17:00',
             'horarioSemanal': dict(SEMANA)}
    datos.update(cambios)
    return datos


class BaseTest(APITestCase):
    def setUp(self):
        cache.clear()  # reinicia los contadores de rate limiting
        self.ana = crear_usuario('ana@correo.cl')
        self.beto = crear_usuario('beto@correo.cl')
        self.medico = crear_usuario('doc@correo.cl', rol='medico')
        self.admin = crear_usuario('admin@correo.cl', is_staff=True, is_superuser=True)

    def login(self, user):
        self.client.force_authenticate(user)

    def crear_med(self, user, **cambios):
        datos = medicamento_payload(**cambios)
        return Medicamento.objects.create(usuario=user, nombre=datos['nombre'],
                                          unidadPastilla=datos['unidadPastilla'],
                                          horaProgramada=datos['horaProgramada'],
                                          horarioSemanal=datos['horarioSemanal'])


# ====================================================== Formato JSON y códigos HTTP
class FormatoJSONTests(BaseTest):
    def test_exito_usa_envoltorio_estandar(self):
        self.login(self.ana)
        r = self.client.get(f'{BASE}/medicamentos/')
        self.assertEqual(r.status_code, 200)
        cuerpo = r.json()
        self.assertTrue(cuerpo['ok'])
        self.assertEqual(cuerpo['status'], 200)
        self.assertIn('results', cuerpo['data'])  # paginación
        self.assertIn('count', cuerpo['data'])

    def test_401_sin_token(self):
        r = self.client.get(f'{BASE}/medicamentos/')
        self.assertEqual(r.status_code, 401)
        self.assertFalse(r.json()['ok'])
        self.assertEqual(r.json()['error']['code'], 'not_authenticated')

    def test_401_token_invalido(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer token.falso.xyz')
        r = self.client.get(f'{BASE}/medicamentos/')
        self.assertEqual(r.status_code, 401)
        self.assertFalse(r.json()['ok'])

    def test_404_recurso_inexistente(self):
        self.login(self.ana)
        r = self.client.get(f'{BASE}/medicamentos/9999/')
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()['error']['code'], 'not_found')

    def test_405_metodo_no_permitido(self):
        self.login(self.ana)
        r = self.client.put(f'{BASE}/auth/perfil/', {})
        self.assertEqual(r.status_code, 405)
        self.assertFalse(r.json()['ok'])

    def test_500_se_devuelve_como_json_sin_filtrar_detalles(self):
        self.login(self.ana)
        with patch('api.views.MedicamentoViewSet.list', side_effect=RuntimeError('secreto interno')):
            with self.assertLogs('api.exceptions', level='ERROR'):
                r = self.client.get(f'{BASE}/medicamentos/')
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()['error']['code'], 'server_error')
        self.assertNotIn('secreto', r.content.decode())

    def test_raiz_publica_lista_endpoints(self):
        r = self.client.get(f'{BASE}/')
        self.assertEqual(r.status_code, 200)
        self.assertIn('medicamentos', r.json()['data'])


# ====================================================== Registro / login / JWT
class AutenticacionTests(BaseTest):
    def test_registro_ok_devuelve_jwt(self):
        r = self.client.post(f'{BASE}/auth/registro/',
                             {'nombre': 'Carla', 'email': 'Carla@Correo.cl', 'password': CLAVE})
        self.assertEqual(r.status_code, 201)
        datos = r.json()['data']
        self.assertTrue(datos['access'] and datos['refresh'])
        self.assertEqual(datos['usuario']['email'], 'carla@correo.cl')
        self.assertEqual(datos['usuario']['rol'], 'paciente')
        self.assertTrue(PerfilUsuario.objects.filter(usuario__email='carla@correo.cl').exists())

    def test_registro_no_permite_autoasignarse_rol_ni_admin(self):
        r = self.client.post(f'{BASE}/auth/registro/', {
            'nombre': 'Mala', 'email': 'mala@correo.cl', 'password': CLAVE,
            'rol': 'medico', 'is_staff': True, 'is_superuser': True})
        self.assertEqual(r.status_code, 201)
        user = User.objects.get(email='mala@correo.cl')
        self.assertEqual(user.perfil.rol, 'paciente')
        self.assertFalse(user.is_staff or user.is_superuser)

    def test_registro_email_duplicado_400(self):
        r = self.client.post(f'{BASE}/auth/registro/',
                             {'nombre': 'Otra Ana', 'email': 'ANA@correo.cl', 'password': CLAVE})
        self.assertEqual(r.status_code, 400)
        self.assertIn('email', r.json()['error']['details'])

    def test_registro_valida_fortaleza_de_clave(self):
        for clave in ('12345678', 'password', 'corta'):
            r = self.client.post(f'{BASE}/auth/registro/',
                                 {'nombre': 'Dani', 'email': 'dani@correo.cl', 'password': clave})
            self.assertEqual(r.status_code, 400, clave)

    def test_registro_sanitiza_nombre(self):
        r = self.client.post(f'{BASE}/auth/registro/', {
            'nombre': '<script>alert(1)</script>', 'email': 'xss@correo.cl', 'password': CLAVE})
        self.assertEqual(r.status_code, 400)
        self.assertIn('nombre', r.json()['error']['details'])

    def test_login_ok(self):
        r = self.client.post(f'{BASE}/auth/login/', {'email': 'ANA@correo.cl', 'password': CLAVE})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['data']['access'])

    def test_login_incorrecto_401_mismo_mensaje(self):
        r1 = self.client.post(f'{BASE}/auth/login/', {'email': 'ana@correo.cl', 'password': 'mala'})
        r2 = self.client.post(f'{BASE}/auth/login/', {'email': 'noexiste@correo.cl', 'password': 'mala'})
        self.assertEqual((r1.status_code, r2.status_code), (401, 401))
        self.assertEqual(r1.json()['error']['message'], r2.json()['error']['message'])

    def test_login_campos_faltantes_400(self):
        r = self.client.post(f'{BASE}/auth/login/', {'email': 'ana@correo.cl'})
        self.assertEqual(r.status_code, 400)

    def test_login_tiene_rate_limiting_429(self):
        codigos = [self.client.post(f'{BASE}/auth/login/',
                                    {'email': 'ana@correo.cl', 'password': 'mala'}).status_code
                   for _ in range(7)]
        self.assertEqual(codigos[:5], [401] * 5)
        self.assertEqual(codigos[5], 429)
        self.assertEqual(self.client.post(f'{BASE}/auth/login/',
                                          {'email': 'ana@correo.cl', 'password': CLAVE}).status_code, 429)

    def test_token_de_acceso_permite_consumir_la_api(self):
        tokens = self.client.post(f'{BASE}/auth/login/',
                                  {'email': 'ana@correo.cl', 'password': CLAVE}).json()['data']
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {tokens["access"]}')
        r = self.client.get(f'{BASE}/auth/perfil/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['data']['email'], 'ana@correo.cl')

    def test_refresh_rota_y_logout_invalida_el_token(self):
        tokens = self.client.post(f'{BASE}/auth/login/',
                                  {'email': 'ana@correo.cl', 'password': CLAVE}).json()['data']
        r = self.client.post(f'{BASE}/auth/refresh/', {'refresh': tokens['refresh']})
        self.assertEqual(r.status_code, 200)
        nuevo = r.json()['data']
        self.assertIn('access', nuevo)
        # el refresh anterior ya fue rotado -> no sirve
        viejo = self.client.post(f'{BASE}/auth/refresh/', {'refresh': tokens['refresh']})
        self.assertEqual(viejo.status_code, 401)
        # logout con el refresh vigente
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {nuevo["access"]}')
        out = self.client.post(f'{BASE}/auth/logout/', {'refresh': nuevo['refresh']})
        self.assertEqual(out.status_code, 200)
        self.client.credentials()
        despues = self.client.post(f'{BASE}/auth/refresh/', {'refresh': nuevo['refresh']})
        self.assertEqual(despues.status_code, 401)

    def test_no_se_puede_cerrar_sesion_con_token_ajeno(self):
        tokens_beto = self.client.post(f'{BASE}/auth/login/',
                                       {'email': 'beto@correo.cl', 'password': CLAVE}).json()['data']
        self.login(self.ana)
        r = self.client.post(f'{BASE}/auth/logout/', {'refresh': tokens_beto['refresh']})
        self.assertEqual(r.status_code, 403)

    def test_refresh_invalido_401(self):
        r = self.client.post(f'{BASE}/auth/refresh/', {'refresh': 'basura'})
        self.assertEqual(r.status_code, 401)


# ====================================================== Permisos y roles
class PermisosTests(BaseTest):
    def test_paciente_no_ve_datos_ajenos(self):
        med_beto = self.crear_med(self.beto)
        self.login(self.ana)
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/').json()['data']['count'], 0)
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/{med_beto.id}/').status_code, 404)
        self.assertEqual(self.client.patch(f'{BASE}/medicamentos/{med_beto.id}/',
                                           {'nombre': 'Hack'}).status_code, 404)
        self.assertEqual(self.client.delete(f'{BASE}/medicamentos/{med_beto.id}/').status_code, 404)
        self.assertTrue(Medicamento.objects.filter(pk=med_beto.pk).exists())

    def test_medico_lee_pero_no_modifica_datos_de_pacientes(self):
        med = self.crear_med(self.ana)
        self.login(self.medico)
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/{med.id}/').status_code, 200)
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/').json()['data']['count'], 1)
        self.assertEqual(self.client.patch(f'{BASE}/medicamentos/{med.id}/',
                                           {'nombre': 'Cambiado'}).status_code, 403)
        self.assertEqual(self.client.delete(f'{BASE}/medicamentos/{med.id}/').status_code, 403)
        self.assertEqual(self.client.post(f'{BASE}/medicamentos/{med.id}/confirmar/').status_code, 403)

    def test_medico_puede_filtrar_por_paciente(self):
        self.crear_med(self.ana)
        self.crear_med(self.beto, nombre='Otro')
        self.login(self.medico)
        r = self.client.get(f'{BASE}/medicamentos/?usuario={self.ana.id}')
        self.assertEqual(r.json()['data']['count'], 1)

    def test_listado_de_pacientes_solo_para_medicos(self):
        self.login(self.ana)
        r = self.client.get(f'{BASE}/pacientes/')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()['error']['code'], 'permission_denied')
        self.login(self.medico)
        r = self.client.get(f'{BASE}/pacientes/')
        self.assertEqual(r.status_code, 200)
        emails = [p['email'] for p in r.json()['data']['results']]
        self.assertIn('ana@correo.cl', emails)
        self.assertNotIn('doc@correo.cl', emails)
        self.assertNotIn('admin@correo.cl', emails)

    def test_admin_puede_eliminar_recursos_ajenos(self):
        med = self.crear_med(self.ana)
        self.login(self.admin)
        self.assertEqual(self.client.delete(f'{BASE}/medicamentos/{med.id}/').status_code, 200)

    def test_endpoint_de_ia_exige_autenticacion(self):
        self.assertEqual(self.client.post(f'{BASE}/recetas/analizar/', {}, format='multipart').status_code, 401)


# ====================================================== CRUD + validaciones: medicamentos
class MedicamentoTests(BaseTest):
    def setUp(self):
        super().setUp()
        self.login(self.ana)

    def test_crud_completo(self):
        r = self.client.post(f'{BASE}/medicamentos/', medicamento_payload())
        self.assertEqual(r.status_code, 201)
        pk = r.json()['data']['id']
        self.assertEqual(r.json()['data']['usuario'], self.ana.id)

        self.assertEqual(self.client.get(f'{BASE}/medicamentos/{pk}/').status_code, 200)

        r = self.client.put(f'{BASE}/medicamentos/{pk}/', medicamento_payload(nombre='Sintrom'))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['data']['nombre'], 'Sintrom')

        r = self.client.patch(f'{BASE}/medicamentos/{pk}/', {'unidadPastilla': '1 mg'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['data']['unidadPastilla'], '1 mg')

        r = self.client.delete(f'{BASE}/medicamentos/{pk}/')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['ok'])
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/{pk}/').status_code, 404)

    def test_el_dueno_y_la_confirmacion_no_se_pueden_falsear(self):
        r = self.client.post(f'{BASE}/medicamentos/', medicamento_payload(
            usuario=self.beto.id, confirmadaHoy=True, fechaUltimaConfirmacion='2026-01-01'))
        self.assertEqual(r.status_code, 201)
        med = Medicamento.objects.get(pk=r.json()['data']['id'])
        self.assertEqual(med.usuario_id, self.ana.id)
        self.assertFalse(med.confirmadaHoy)
        self.assertIsNone(med.fechaUltimaConfirmacion)

    def test_validaciones_400(self):
        casos = {
            'nombre vacío': medicamento_payload(nombre=''),
            'nombre con html': medicamento_payload(nombre='<b>x</b>'),
            'falta un día': medicamento_payload(horarioSemanal={k: v for k, v in SEMANA.items() if k != 'lunes'}),
            'día inventado': medicamento_payload(horarioSemanal={**SEMANA, 'lunez': '1'}),
            'dosis inválida': medicamento_payload(horarioSemanal={**SEMANA, 'lunes': 'dos pastillas'}),
            'división por cero': medicamento_payload(horarioSemanal={**SEMANA, 'lunes': '1/0'}),
            'sin ninguna dosis': medicamento_payload(horarioSemanal={d: '' for d in SEMANA}),
            'horario no es objeto': medicamento_payload(horarioSemanal=['1', '2']),
            'hora inválida': medicamento_payload(horaProgramada='25:99'),
            'control en el pasado': medicamento_payload(
                proximoControl=(timezone.localdate() - timedelta(days=3)).isoformat()),
        }
        for nombre, payload in casos.items():
            r = self.client.post(f'{BASE}/medicamentos/', payload)
            self.assertEqual(r.status_code, 400, nombre)
            self.assertFalse(r.json()['ok'], nombre)
            self.assertEqual(r.json()['error']['code'], 'validation_error', nombre)

    def test_dosis_validas_se_normalizan(self):
        r = self.client.post(f'{BASE}/medicamentos/', medicamento_payload(
            horarioSemanal={**SEMANA, 'lunes': 1, 'sabado': None}))
        self.assertEqual(r.status_code, 201)
        horario = r.json()['data']['horarioSemanal']
        self.assertEqual(horario['lunes'], '1')
        self.assertEqual(horario['sabado'], '')

    def test_json_malformado_400(self):
        r = self.client.post(f'{BASE}/medicamentos/', '{esto no es json', content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.json()['ok'])

    def test_busqueda_orden_y_paginacion(self):
        for nombre in ('Zeta', 'Alfa', 'Beta'):
            self.crear_med(self.ana, nombre=nombre)
        r = self.client.get(f'{BASE}/medicamentos/?search=alf')
        self.assertEqual(r.json()['data']['count'], 1)
        r = self.client.get(f'{BASE}/medicamentos/?ordering=-nombre&page_size=2')
        datos = r.json()['data']
        self.assertEqual([m['nombre'] for m in datos['results']], ['Zeta', 'Beta'])
        self.assertEqual(datos['count'], 3)
        self.assertIsNotNone(datos['next'])
        self.assertEqual(self.client.get(f'{BASE}/medicamentos/?page=99').status_code, 404)

    def test_confirmar_toma_crea_registro(self):
        med = self.crear_med(self.ana)
        r = self.client.post(f'{BASE}/medicamentos/{med.id}/confirmar/')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['data']['confirmadaHoy'])
        self.assertEqual(RegistroToma.objects.filter(medicamento=med, estado='tomada').count(), 1)

    def test_confirmada_hoy_caduca_al_dia_siguiente(self):
        med = self.crear_med(self.ana)
        med.confirmadaHoy = True
        med.fechaUltimaConfirmacion = timezone.localdate() - timedelta(days=1)
        med.save()
        r = self.client.get(f'{BASE}/medicamentos/{med.id}/')
        self.assertFalse(r.json()['data']['confirmadaHoy'])


# ====================================================== Registros INR
class RegistroINRTests(BaseTest):
    def setUp(self):
        super().setUp()
        self.login(self.ana)

    def payload(self, **c):
        d = {'valorINR': 2.4, 'rangoTerapeuticoMin': 2.0, 'rangoTerapeuticoMax': 3.0}
        d.update(c)
        return d

    def test_crud(self):
        r = self.client.post(f'{BASE}/registros-inr/', self.payload())
        self.assertEqual(r.status_code, 201)
        pk = r.json()['data']['id']
        self.assertEqual(self.client.get(f'{BASE}/registros-inr/').json()['data']['count'], 1)
        r = self.client.patch(f'{BASE}/registros-inr/{pk}/', {'valorINR': 2.6})
        self.assertEqual(r.status_code, 200)
        r = self.client.put(f'{BASE}/registros-inr/{pk}/', self.payload(valorINR=2.8))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.delete(f'{BASE}/registros-inr/{pk}/').status_code, 200)
        self.assertEqual(self.client.get(f'{BASE}/registros-inr/{pk}/').status_code, 404)

    def test_estado_siempre_sin_evaluar_aunque_el_cliente_lo_envie(self):
        r = self.client.post(f'{BASE}/registros-inr/', self.payload(estadoAlerta='critico', usuario=self.beto.id))
        self.assertEqual(r.status_code, 201)
        reg = RegistroINR.objects.get(pk=r.json()['data']['id'])
        self.assertEqual(reg.estadoAlerta, 'sin_evaluar')
        self.assertEqual(reg.usuario_id, self.ana.id)

    def test_validaciones_400(self):
        casos = {
            'rango invertido': self.payload(rangoTerapeuticoMin=3.0, rangoTerapeuticoMax=2.0),
            'rango igual': self.payload(rangoTerapeuticoMin=2.0, rangoTerapeuticoMax=2.0),
            'inr absurdo': self.payload(valorINR=99),
            'inr negativo': self.payload(valorINR=-1),
            'inr texto': self.payload(valorINR='abc'),
            'falta campo': {'valorINR': 2.4},
        }
        for nombre, payload in casos.items():
            r = self.client.post(f'{BASE}/registros-inr/', payload)
            self.assertEqual(r.status_code, 400, nombre)

    def test_patch_valida_contra_el_rango_existente(self):
        pk = self.client.post(f'{BASE}/registros-inr/', self.payload()).json()['data']['id']
        r = self.client.patch(f'{BASE}/registros-inr/{pk}/', {'rangoTerapeuticoMin': 3.5})
        self.assertEqual(r.status_code, 400)


# ====================================================== Registros de toma
class RegistroTomaTests(BaseTest):
    def setUp(self):
        super().setUp()
        self.login(self.ana)
        self.med = self.crear_med(self.ana)

    def test_crud(self):
        r = self.client.post(f'{BASE}/tomas/', {'medicamento': self.med.id, 'estado': 'omitida',
                                                'dosis': '1/2', 'notas': 'Me olvidé'})
        self.assertEqual(r.status_code, 201)
        pk = r.json()['data']['id']
        self.assertEqual(r.json()['data']['medicamentoNombre'], 'Neosintrom')
        self.assertEqual(self.client.get(f'{BASE}/tomas/?medicamento={self.med.id}').json()['data']['count'], 1)
        self.assertEqual(self.client.patch(f'{BASE}/tomas/{pk}/', {'estado': 'tomada'}).status_code, 200)
        self.assertEqual(self.client.delete(f'{BASE}/tomas/{pk}/').status_code, 200)

    def test_no_se_puede_registrar_toma_de_medicamento_ajeno(self):
        ajeno = self.crear_med(self.beto)
        r = self.client.post(f'{BASE}/tomas/', {'medicamento': ajeno.id})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(RegistroToma.objects.count(), 0)

    def test_validaciones(self):
        futuro = (timezone.now() + timedelta(days=2)).isoformat()
        self.assertEqual(self.client.post(f'{BASE}/tomas/', {'medicamento': self.med.id,
                                                             'fechaHora': futuro}).status_code, 400)
        self.assertEqual(self.client.post(f'{BASE}/tomas/', {'medicamento': self.med.id,
                                                             'estado': 'quizas'}).status_code, 400)
        self.assertEqual(self.client.post(f'{BASE}/tomas/', {'medicamento': self.med.id,
                                                             'dosis': 'mucha'}).status_code, 400)
        self.assertEqual(self.client.post(f'{BASE}/tomas/', {'medicamento': self.med.id,
                                                             'notas': '<img onerror=x>'}).status_code, 400)
        self.assertEqual(self.client.post(f'{BASE}/tomas/', {'medicamento': 9999}).status_code, 400)

    def test_borrar_medicamento_borra_sus_tomas(self):
        RegistroToma.objects.create(medicamento=self.med)
        self.client.delete(f'{BASE}/medicamentos/{self.med.id}/')
        self.assertEqual(RegistroToma.objects.count(), 0)


# ====================================================== Análisis de receta con IA
def imagen_png(tamano=(20, 20)):
    buf = BytesIO()
    Image.new('RGB', tamano, 'white').save(buf, format='PNG')
    return buf.getvalue()


class AnalizarRecetaTests(BaseTest):
    URL = f'{BASE}/recetas/analizar/'

    def setUp(self):
        super().setUp()
        self.login(self.ana)

    def subir(self, contenido, nombre='receta.png', tipo='image/png'):
        return self.client.post(self.URL, {'imagen': SimpleUploadedFile(nombre, contenido, tipo)},
                                format='multipart')

    def test_sin_imagen_400(self):
        r = self.client.post(self.URL, {}, format='multipart')
        self.assertEqual(r.status_code, 400)

    def test_archivo_que_no_es_imagen_400(self):
        r = self.subir(b'esto es un exe disfrazado', 'virus.png')
        self.assertEqual(r.status_code, 400)

    def test_imagen_demasiado_grande_400(self):
        with self.settings(RECETA_MAX_BYTES=100):
            r = self.subir(imagen_png((200, 200)))
        self.assertEqual(r.status_code, 400)

    def test_sin_clave_gemini_503(self):
        with self.settings(GEMINI_API_KEY=''):
            r = self.subir(imagen_png())
        self.assertEqual(r.status_code, 503)

    def test_ia_ok_200(self):
        esperado = {'inr_actual': '2.5', 'rango_terapeutico': '2.0 - 3.0', 'medicamentos': []}
        with patch('api.views.analizar_hoja_con_gemini', return_value=esperado) as falso:
            r = self.subir(imagen_png())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['data'], esperado)
        self.assertTrue(falso.call_args[0][0].startswith(b'\xff\xd8'))  # se reenvía como JPEG limpio

    def test_ia_falla_502(self):
        with patch('api.views.analizar_hoja_con_gemini', side_effect=IAResponseError('formato inválido')):
            r = self.subir(imagen_png())
        self.assertEqual(r.status_code, 502)
        self.assertFalse(r.json()['ok'])

    def test_ia_sin_configurar_503(self):
        with patch('api.views.analizar_hoja_con_gemini', side_effect=IAConfigError('sin clave')):
            self.assertEqual(self.subir(imagen_png()).status_code, 503)

    def test_rate_limit_ia_429(self):
        with patch('api.views.analizar_hoja_con_gemini', return_value={'medicamentos': []}):
            codigos = [self.subir(imagen_png()).status_code for _ in range(11)]
        self.assertEqual(codigos[:10], [200] * 10)
        self.assertEqual(codigos[10], 429)


class CorsYDespliegueTests(APITestCase):
    """El frontend (otro dominio) debe poder llamar a la API; un origen desconocido, no."""

    def test_preflight_origen_permitido(self):
        r = self.client.options('/api/v1/auth/login/', HTTP_ORIGIN='http://localhost:5500',
                                HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
                                HTTP_ACCESS_CONTROL_REQUEST_HEADERS='authorization,content-type')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Access-Control-Allow-Origin'], 'http://localhost:5500')
        self.assertIn('authorization', r['Access-Control-Allow-Headers'])

    def test_preflight_origen_no_permitido(self):
        r = self.client.options('/api/v1/auth/login/', HTTP_ORIGIN='https://sitio-malicioso.example',
                                HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST')
        self.assertNotIn('Access-Control-Allow-Origin', r)

    def test_raiz_responde_json(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['ok'])
