from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class PerfilUsuario(models.Model):
    """Perfil 1-a-1 con User: guarda el rol usado para el control de acceso."""

    class Rol(models.TextChoices):
        PACIENTE = 'paciente', 'Paciente'
        MEDICO = 'medico', 'Médico'

    usuario = models.OneToOneField(User, on_delete=models.CASCADE, related_name='perfil')
    rol = models.CharField(max_length=20, choices=Rol.choices, default=Rol.PACIENTE)
    creado = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.usuario.username} ({self.rol})'


class Medicamento(models.Model):
    # Un usuario tiene muchos medicamentos (One-to-Many)
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name='medicamentos')
    nombre = models.CharField(max_length=100)
    unidadPastilla = models.CharField(max_length=100)
    horaProgramada = models.TimeField()
    # Ej.: {"lunes": "1", "martes": "1/2", ..., "domingo": ""}
    horarioSemanal = models.JSONField()
    periodicidad = models.CharField(max_length=50, default='semanal')
    proximoControl = models.DateField(null=True, blank=True)
    confirmadaHoy = models.BooleanField(default=False)
    fechaUltimaConfirmacion = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ['nombre', 'id']

    def __str__(self):
        return self.nombre

    @property
    def propietario(self):
        return self.usuario


class RegistroToma(models.Model):
    """Cada vez que el paciente toma (u omite) un medicamento (One-to-Many con Medicamento)."""

    class Estado(models.TextChoices):
        TOMADA = 'tomada', 'Tomada'
        OMITIDA = 'omitida', 'Omitida'

    medicamento = models.ForeignKey(Medicamento, on_delete=models.CASCADE, related_name='tomas')
    fechaHora = models.DateTimeField(default=timezone.now)
    estado = models.CharField(max_length=10, choices=Estado.choices, default=Estado.TOMADA)
    dosis = models.CharField(max_length=20, blank=True, default='')
    notas = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        ordering = ['-fechaHora', '-id']

    def __str__(self):
        return f'{self.medicamento.nombre} - {self.estado} ({self.fechaHora:%d-%m-%Y %H:%M})'

    @property
    def propietario(self):
        return self.medicamento.usuario


class RegistroINR(models.Model):
    # Un usuario tiene muchas lecturas de INR (One-to-Many)
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name='registros_inr')
    valorINR = models.FloatField()
    rangoTerapeuticoMin = models.FloatField()
    rangoTerapeuticoMax = models.FloatField()
    # La app NO interpreta resultados clínicos: siempre queda "sin_evaluar".
    estadoAlerta = models.CharField(max_length=20, default='sin_evaluar')
    fechaLectura = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-fechaLectura', '-id']

    def __str__(self):
        return f'INR {self.valorINR} - {self.usuario.username}'

    @property
    def propietario(self):
        return self.usuario
