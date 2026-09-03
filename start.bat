@echo off
cd /d "%~dp0"
title ngrbet
echo Lancement du casino sur http://localhost:5173 ...
echo (ferme cette fenetre pour arreter le serveur)
npm start
pause
