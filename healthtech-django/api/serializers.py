import re
from datetime import timedelta

from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.utils import timezone
from rest_framework import serializers

from .exceptions import CredencialesIncorrectas
from .ia import DIAS
from .models import Medicamento, RegistroINR, RegistroToma
from .permissions import es_admin, rol_de

# Rango plausible de un INR; fuera de él casi seguro es un error de digitación/lectura.
INR_MIN, INR_MAX = 0.5, 10.0

# Dosis válidas: 1 | 1,5 | 1/2 | 1+1/4  (vacío = sin dosis ese día)
DOSIS_RE = re.compile(r'^(?:\d{1,2}(?:[.,]\d{1,2})?|[1-9]\d?/[1-9]\d?|\d{1,2}\+[1-9]\d?/[1-9]\d?)$')
# Sanitización de texto libre: sin etiquetas HTML ni caracteres de control.
PROHIBIDOS_RE = re.compile(r'[<>\x00-\x08\x0b\x0c\x0e-\x1f]')


def limpiar_texto(valor):
    """Rechaza < > y caracteres de control (anti XSS/inyección) y normaliza espacios."""
    valor = str(valor)
    if PROHIBIDOS_RE.search(valor):
        raise serializers.ValidationError('No se permiten los caracteres < > ni caracteres de control.')
    return ' '.join(valor.split())


def validar_dosis(valor):
    texto = '' if valor is None else str(valor).strip()
    if isinstance(valor, bool):
        raise serializers.ValidationError('Dosis inválida.')
    if texto and not DOSIS_RE.match(texto):
        raise serializers.ValidationError(f'Dosis inválida: "{texto}". Usa formatos como 1, 1/2 o 1+1/4.')
    return texto


# ---------------------------------------------------------------- Usuarios / auth
class UsuarioSerializer(serializers.ModelSerializer):
    nombre = serializers.CharField(source='first_name', read_only=True)
    rol = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ('id', 'nombre', 'email', 'rol')
        read_only_fields = fields

    def get_rol(self, obj):
        return rol_de(obj)


class RegistroUsuarioSerializer(serializers.Serializer):
    """El rol NO es un campo de entrada: todo registro público es 'paciente' (anti escalada de privilegios)."""
    nombre = serializers.CharField(min_length=2, max_length=100)
    email = serializers.EmailField(max_length=150)
    password = serializers.CharField(write_only=True, min_length=8, max_length=128,
                                     style={'input_type': 'password'})

    def validate_nombre(self, value):
        return limpiar_texto(value)

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError('Este correo ya está registrado.')
        return value

    def validate(self, attrs):
        usuario_tmp = User(username=attrs['email'], email=attrs['email'], first_name=attrs['nombre'])
        try:
            validate_password(attrs['password'], user=usuario_tmp)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({'password': list(exc.messages)})
        return attrs

    def create(self, validated_data):
        try:
            return User.objects.create_user(
                username=validated_data['email'], email=validated_data['email'],
                password=validated_data['password'], first_name=validated_data['nombre'],
            )
        except IntegrityError:  # carrera entre dos registros simultáneos
            raise serializers.ValidationError({'email': ['Este correo ya está registrado.']})


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField(write_only=True)
    password = serializers.CharField(write_only=True, style={'input_type': 'password'})

    def validate(self, attrs):
        user = authenticate(request=self.context.get('request'),
                            username=attrs['email'].strip().lower(), password=attrs['password'])
        if user is None or not user.is_active:
            # Mismo mensaje para "no existe" y "clave incorrecta": evita enumerar usuarios.
            raise CredencialesIncorrectas()
        attrs['user'] = user
        return attrs


# ---------------------------------------------------------------- Medicamentos
class MedicamentoSerializer(serializers.ModelSerializer):
    nombre = serializers.CharField(min_length=2, max_length=100)
    unidadPastilla = serializers.CharField(max_length=100)

    class Meta:
        model = Medicamento
        fields = ('id', 'usuario', 'nombre', 'unidadPastilla', 'horaProgramada', 'horarioSemanal',
                  'periodicidad', 'proximoControl', 'confirmadaHoy', 'fechaUltimaConfirmacion')
        # El dueño y la confirmación diaria NO se aceptan desde el cliente (mass assignment).
        read_only_fields = ('id', 'usuario', 'confirmadaHoy', 'fechaUltimaConfirmacion')

    def validate_nombre(self, value):
        return limpiar_texto(value)

    def validate_unidadPastilla(self, value):
        return limpiar_texto(value)

    def validate_periodicidad(self, value):
        return limpiar_texto(value)

    def validate_horarioSemanal(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Debe ser un objeto con los 7 días de la semana.')
        faltan = [d for d in DIAS if d not in value]
        sobran = [k for k in value if k not in DIAS]
        if faltan or sobran:
            raise serializers.ValidationError(
                f'Claves inválidas. Faltan: {faltan or "ninguna"}. No permitidas: {sobran or "ninguna"}.')
        limpio = {}
        for dia in DIAS:
            try:
                limpio[dia] = validar_dosis(value[dia])
            except serializers.ValidationError as exc:
                raise serializers.ValidationError({dia: exc.detail})
        if not any(limpio.values()):
            raise serializers.ValidationError('Debe indicar la dosis de al menos un día.')
        return limpio

    def validate_proximoControl(self, value):
        sin_cambios = self.instance is not None and self.instance.proximoControl == value
        if value and value < timezone.localdate() and not sin_cambios:
            raise serializers.ValidationError('La fecha del próximo control no puede estar en el pasado.')
        return value

    def to_representation(self, instance):
        datos = super().to_representation(instance)
        # "Confirmada hoy" solo es verdad si la última confirmación fue hoy.
        datos['confirmadaHoy'] = instance.fechaUltimaConfirmacion == timezone.localdate()
        return datos


# ---------------------------------------------------------------- Registros INR
class RegistroINRSerializer(serializers.ModelSerializer):
    class Meta:
        model = RegistroINR
        fields = ('id', 'usuario', 'valorINR', 'rangoTerapeuticoMin', 'rangoTerapeuticoMax',
                  'estadoAlerta', 'fechaLectura')
        read_only_fields = ('id', 'usuario', 'estadoAlerta', 'fechaLectura')

    @staticmethod
    def _en_rango(valor, campo):
        if not INR_MIN <= valor <= INR_MAX:
            raise serializers.ValidationError(f'{campo} debe estar entre {INR_MIN} y {INR_MAX}.')
        return valor

    def validate_valorINR(self, value):
        return self._en_rango(value, 'El INR')

    def validate_rangoTerapeuticoMin(self, value):
        return self._en_rango(value, 'El mínimo del rango')

    def validate_rangoTerapeuticoMax(self, value):
        return self._en_rango(value, 'El máximo del rango')

    def validate(self, attrs):
        minimo = attrs.get('rangoTerapeuticoMin', getattr(self.instance, 'rangoTerapeuticoMin', None))
        maximo = attrs.get('rangoTerapeuticoMax', getattr(self.instance, 'rangoTerapeuticoMax', None))
        if minimo is not None and maximo is not None and minimo >= maximo:
            raise serializers.ValidationError(
                {'rangoTerapeuticoMin': ['El mínimo debe ser menor que el máximo del rango.']})
        return attrs


# ---------------------------------------------------------------- Tomas
class RegistroTomaSerializer(serializers.ModelSerializer):
    medicamentoNombre = serializers.CharField(source='medicamento.nombre', read_only=True)

    class Meta:
        model = RegistroToma
        fields = ('id', 'medicamento', 'medicamentoNombre', 'fechaHora', 'estado', 'dosis', 'notas')
        read_only_fields = ('id',)

    def validate_medicamento(self, value):
        user = self.context['request'].user
        if not (es_admin(user) or value.usuario_id == user.pk):
            # Mismo mensaje que "no existe": no revela medicamentos ajenos.
            raise serializers.ValidationError('El medicamento no existe o no te pertenece.')
        return value

    def validate_fechaHora(self, value):
        if value > timezone.now() + timedelta(minutes=5):
            raise serializers.ValidationError('La fecha y hora de la toma no puede estar en el futuro.')
        return value

    def validate_dosis(self, value):
        return validar_dosis(value)

    def validate_notas(self, value):
        return limpiar_texto(value)
