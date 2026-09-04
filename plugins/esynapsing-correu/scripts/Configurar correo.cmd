@echo off
REM Doble clic aqui para configurar el correo.
REM Abre el configurador, que pregunta los datos uno a uno.
title eSynapsing Correu - configuracion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-windows.ps1"
if errorlevel 1 (
  echo.
  echo Ha ocurrido un error. Copia el mensaje de arriba y enviaselo a soporte.
  echo.
  pause
)
