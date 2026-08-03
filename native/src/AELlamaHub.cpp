/*
 * AELlamaHub.cpp -- minimal AEGP: adds "AE Llama Panel" to the Window menu,
 * which opens the CEP panel. Scaffold for phase-2 native features
 * (in-process inference, render hooks) -- see native/README.md.
 */

#include "AEConfig.h"
#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "AEGP_SuiteHandler.h"

static AEGP_PluginID    S_plugin_id  = 0;
static AEGP_Command     S_open_panel = 0;
static SPBasicSuite    *S_sp_basic   = nullptr;

// Opens Window > Extensions > AE Llama via scripting -- the panel itself
// stays a CEP extension; this just gives it a first-class menu item.
static const char *kOpenPanelScript =
    "(function () {"
    "  var id = app.findMenuCommandId('AE Llama');"
    "  if (id > 0) { app.executeCommand(id); }"
    "  else { alert('AE Llama panel is not installed.'); }"
    "})();";

static A_Err CommandHook(
    AEGP_GlobalRefcon,
    AEGP_CommandRefcon,
    AEGP_Command   command,
    AEGP_HookPriority,
    A_Boolean,
    A_Boolean     *handledPB)
{
    A_Err err = A_Err_NONE;
    if (command != S_open_panel) {
        return err;
    }
    AEGP_SuiteHandler suites(S_sp_basic);
    AEGP_MemHandle    resultH = nullptr;
    AEGP_MemHandle    errorH  = nullptr;
    ERR(suites.UtilitySuite6()->AEGP_ExecuteScript(
        S_plugin_id, kOpenPanelScript, FALSE, &resultH, &errorH));
    if (resultH) suites.MemorySuite1()->AEGP_FreeMemHandle(resultH);
    if (errorH)  suites.MemorySuite1()->AEGP_FreeMemHandle(errorH);
    *handledPB = TRUE;
    return err;
}

static A_Err UpdateMenuHook(
    AEGP_GlobalRefcon,
    AEGP_UpdateMenuRefcon,
    AEGP_WindowType)
{
    A_Err err = A_Err_NONE;
    AEGP_SuiteHandler suites(S_sp_basic);
    ERR(suites.CommandSuite1()->AEGP_EnableCommand(S_open_panel));
    return err;
}

extern "C" DllExport A_Err EntryPointFunc(
    struct SPBasicSuite  *pica_basicP,
    A_long                /* major_versionL */,
    A_long                /* minor_versionL */,
    AEGP_PluginID         aegp_plugin_id,
    AEGP_GlobalRefcon    * /* global_refconP */)
{
    A_Err err = A_Err_NONE;
    S_sp_basic  = pica_basicP;
    S_plugin_id = aegp_plugin_id;

    AEGP_SuiteHandler suites(pica_basicP);

    ERR(suites.CommandSuite1()->AEGP_GetUniqueCommand(&S_open_panel));
    ERR(suites.CommandSuite1()->AEGP_InsertMenuCommand(
        S_open_panel, "AE Llama Panel", AEGP_Menu_WINDOW,
        AEGP_MENU_INSERT_SORTED));

    ERR(suites.RegisterSuite5()->AEGP_RegisterCommandHook(
        aegp_plugin_id, AEGP_HP_BeforeAE, AEGP_Command_ALL,
        CommandHook, nullptr));
    ERR(suites.RegisterSuite5()->AEGP_RegisterUpdateMenuHook(
        aegp_plugin_id, UpdateMenuHook, nullptr));

    return err;
}
