@echo off
rem Runs a command inside the Visual Studio C++ build environment, with the CMake and Ninja that
rem ship with the Build Tools. Morf's speech engine (transcribe.cpp) is C++ built by CMake.
rem   scripts\vsbuild.cmd cargo build
rem   scripts\vsbuild.cmd npx tauri build

set "VSROOT=%ProgramFiles(x86)%\Microsoft Visual Studio\2022"
set "VSROOT64=%ProgramFiles%\Microsoft Visual Studio\2022"
set "VSDIR="
call :try "%VSROOT%\BuildTools"
call :try "%VSROOT%\Community"
call :try "%VSROOT%\Professional"
call :try "%VSROOT%\Enterprise"
call :try "%VSROOT64%\BuildTools"
call :try "%VSROOT64%\Community"
call :try "%VSROOT64%\Professional"
call :try "%VSROOT64%\Enterprise"
if not defined VSDIR (
  echo Visual Studio C++ Build Tools not found. Install them: winget install Microsoft.VisualStudio.2022.BuildTools
  exit /b 1
)

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>nul
set "PATH=%VSDIR%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VSDIR%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%USERPROFILE%\.cargo\bin;%PATH%"
set CMAKE_GENERATOR=Ninja

rem transcribe-cpp-sys builds through a junction under %LOCALAPPDATA%\tcs to stay under MAX_PATH.
rem That junction fails in some sandboxed shells; MORF_DIRECT_NATIVE_BUILD=1 builds in target\ instead.
if "%MORF_DIRECT_NATIVE_BUILD%"=="1" set "LOCALAPPDATA="
if "%MORF_DIRECT_NATIVE_BUILD%"=="1" set "TEMP="
%*
exit /b %ERRORLEVEL%

:try
if defined VSDIR exit /b 0
if exist "%~1\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%~1"
exit /b 0
