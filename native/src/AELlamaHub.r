#include "AEConfig.h"
#include "AE_EffectVers.h"

#ifndef AE_OS_WIN
    #include <AE_General.r>
#endif

resource 'PiPL' (16000) {
    {
        Kind { AEGP },
        Name { "AELlamaHub" },
        Category { "General Plugin" },
        Version { 131072 },
        EntryPoint { "EntryPointFunc" }
    }
};
