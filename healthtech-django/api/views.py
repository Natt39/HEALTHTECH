import logging

from django.conf import settings
from django.contrib.auth.models import User, update_last_login
from django.http import JsonResponse
from django.utils import timezone
from PIL import Image, UnidentifiedImageError
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.reverse import reverse
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .exceptions import ErrorServicioExterno, ServicioNoDisponible
from .ia import IAConfigError, IAResponseError, analizar_hoja_con_gemini, normalizar_imagen
from .models import Medicamento, RegistroINR, RegistroToma
from .permissions import IsMedico, IsOwnerOrMedicoReadOnly, es_admin, es_medico
from .serializers import (LoginSerializer, MedicamentoSerializer, RegistroINRSerializer,
                          RegistroTomaSerializer, RegistroUsuarioSerializer, UsuarioSerializer)

logger = logging.getLogger(__name__)


def home_view(request):
    return JsonResponse({'ok': True, 'status': 200, 'data': {
        'nombre': 'HealthTech TACO API', 'version': 'v1', 'api': '/api/v1/', 'admin': '/admin/'}})


def emitir_tokens(user):
    refresh = RefreshToken.for_user(user)
    return {'access': str(refresh.access_token), 'refresh': str(refresh),
            'usuario': UsuarioSerializer(user).data}


# ================================================================ Raíz de la API
class ApiRootView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        r = lambda nombre: reverse(nombre, request=request)  # noqa: E731
        return Response({
            'auth': {'registro': r('auth-registro'), 'login': r('auth-login'),
                     'refresh': r('auth-refresh'), 'logout': r('auth-logout'), 'perfil': r('auth-perfil')},
            'medicamentos': r('medicamento-list'),
            'registros-inr': r('registroinr-list'),
            'tomas': r('registrotoma-list'),
            'pacientes (solo médicos)': r('paciente-list'),
            'recetas/analizar': r('recetas-analizar'),
        })


# ================================================================ Autenticación (JWT)
class RegistroView(GenericAPIView):
    serializer_class = RegistroUsuarioSerializer
    permission_classes = [AllowAny]
    authentication_classes = []  # un token vencido no debe impedir registrarse
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'registro'

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(emitir_tokens(user), status=status.HTTP_201_CREATED)


class LoginView(GenericAPIView):
    serializer_class = LoginSerializer
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'  # 5/min por IP: frena la fuerza bruta

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        update_last_login(None, user)
        return Response(emitir_tokens(user), status=status.HTTP_200_OK)


class RefrescarTokenView(TokenRefreshView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'refresh'


class LogoutView(APIView):
    """Invalida el refresh token (blacklist) para que no pueda reutilizarse."""

    def post(self, request):
        refresh = request.data.get('refresh')
        if not refresh or not isinstance(refresh, str):
            raise ValidationError({'refresh': ['Este campo es requerido.']})
        try:
            token = RefreshToken(refresh)
        except TokenError:
            raise ValidationError({'refresh': ['Token de refresco inválido o ya utilizado.']})
        if str(token.get('user_id')) != str(request.user.pk):
            raise PermissionDenied('Ese token no pertenece a tu sesión.')
        token.blacklist()
        return Response({'mensaje': 'Sesión cerrada correctamente.'}, status=status.HTTP_200_OK)


class PerfilView(APIView):
    def get(self, request):
        return Response(UsuarioSerializer(request.user).data)


# ================================================================ CRUD protegido por dueño/rol
class MisRecursosMixin:
    """
    - Paciente: solo ve y modifica lo suyo (lo ajeno responde 404, sin revelar que existe).
    - Médico: ve todo (solo lectura; escribir en lo ajeno responde 403).
    - Admin: acceso total.
    """
    permission_classes = [IsAuthenticated, IsOwnerOrMedicoReadOnly]
    campo_propietario = 'usuario'
    filtro_extra = {'usuario': 'usuario'}  # ?usuario=<id> (solo médico/admin)

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if not (es_admin(user) or es_medico(user)):
            return qs.filter(**{self.campo_propietario: user})
        for parametro, campo in self.filtro_extra.items():
            valor = self.request.query_params.get(parametro)
            if valor and valor.isdigit():
                qs = qs.filter(**{campo: int(valor)})
        return qs

    def destroy(self, request, *args, **kwargs):
        self.perform_destroy(self.get_object())
        return Response({'mensaje': 'Recurso eliminado correctamente.'}, status=status.HTTP_200_OK)


class MedicamentoViewSet(MisRecursosMixin, viewsets.ModelViewSet):
    queryset = Medicamento.objects.select_related('usuario')
    serializer_class = MedicamentoSerializer
    search_fields = ('nombre',)
    ordering_fields = ('nombre', 'horaProgramada', 'proximoControl')

    def perform_create(self, serializer):
        serializer.save(usuario=self.request.user)

    @action(detail=True, methods=['post'], url_path='confirmar')
    def confirmar(self, request, pk=None):
        """Marca la toma de hoy y deja constancia en RegistroToma."""
        medicamento = self.get_object()  # dueño o admin; un médico recibe 403
        hoy = timezone.localdate()
        medicamento.confirmadaHoy = True
        medicamento.fechaUltimaConfirmacion = hoy
        medicamento.save(update_fields=['confirmadaHoy', 'fechaUltimaConfirmacion'])
        dia = ('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo')[hoy.weekday()]
        dosis = (medicamento.horarioSemanal or {}).get(dia, '')
        RegistroToma.objects.create(medicamento=medicamento, dosis=dosis or '',
                                    estado=RegistroToma.Estado.TOMADA)
        return Response(self.get_serializer(medicamento).data, status=status.HTTP_200_OK)


class RegistroINRViewSet(MisRecursosMixin, viewsets.ModelViewSet):
    queryset = RegistroINR.objects.select_related('usuario')
    serializer_class = RegistroINRSerializer
    ordering_fields = ('fechaLectura', 'valorINR')
    search_fields = ()

    def perform_create(self, serializer):
        # estadoAlerta siempre "sin_evaluar": la app no interpreta resultados clínicos.
        serializer.save(usuario=self.request.user, estadoAlerta='sin_evaluar')


class RegistroTomaViewSet(MisRecursosMixin, viewsets.ModelViewSet):
    queryset = RegistroToma.objects.select_related('medicamento__usuario')
    serializer_class = RegistroTomaSerializer
    campo_propietario = 'medicamento__usuario'
    filtro_extra = {'usuario': 'medicamento__usuario'}
    ordering_fields = ('fechaHora',)
    search_fields = ('medicamento__nombre',)

    def get_queryset(self):
        qs = super().get_queryset()
        med = self.request.query_params.get('medicamento')
        if med and med.isdigit():  # los pacientes también pueden filtrar por su medicamento
            qs = qs.filter(medicamento_id=int(med))
        return qs


class PacienteViewSet(viewsets.ReadOnlyModelViewSet):
    """Listado de pacientes: exclusivo para médicos (403 para el resto)."""
    permission_classes = [IsAuthenticated, IsMedico]
    serializer_class = UsuarioSerializer
    queryset = (User.objects.filter(is_staff=False, is_superuser=False, perfil__rol='paciente')
                .select_related('perfil').order_by('first_name', 'id'))
    search_fields = ('first_name', 'email')
    ordering_fields = ('first_name', 'id')


# ================================================================ IA: análisis de receta
class AnalizarRecetaView(APIView):
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'ia'  # cada llamada consume cuota de Gemini

    TIPOS_PERMITIDOS = {'JPEG', 'PNG', 'WEBP'}

    def post(self, request):
        archivo = request.FILES.get('imagen')
        if not archivo:
            raise ValidationError({'imagen': ['No se envió ninguna imagen.']})
        if archivo.size > settings.RECETA_MAX_BYTES:
            raise ValidationError({'imagen': [f'La imagen supera los {settings.RECETA_MAX_BYTES // 1048576} MB.']})
        try:
            if Image.open(archivo).format not in self.TIPOS_PERMITIDOS:
                raise ValidationError({'imagen': ['Formato no permitido. Usa JPEG, PNG o WEBP.']})
            archivo.seek(0)
            jpeg = normalizar_imagen(archivo)
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise ValidationError({'imagen': ['Archivo de imagen inválido o corrupto.']})
        try:
            datos = analizar_hoja_con_gemini(jpeg)
        except IAConfigError as exc:
            raise ServicioNoDisponible(str(exc))
        except IAResponseError as exc:
            raise ErrorServicioExterno(str(exc))
        return Response(datos, status=status.HTTP_200_OK)
