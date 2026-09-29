#include "main.hpp"
#include "STmanager.hpp"

#include "scotland2/shared/modloader.h"

#include "GlobalNamespace/NoteController.hpp"
#include "GlobalNamespace/NoteCutInfo.hpp"
#include "GlobalNamespace/PauseController.hpp"
#include "GlobalNamespace/RelativeScoreAndImmediateRankCounter.hpp"
#include "GlobalNamespace/ScoreController.hpp"
#include "GlobalNamespace/StandardLevelGameplayManager.hpp"

#include <android/log.h>
#include <mutex>

using namespace GlobalNamespace;

static modloader::ModInfo modInfo{MOD_ID, VERSION, 0};

static void EnsureServer() {
    static std::once_flag once;
    std::call_once(once, [] {
        if (!stManager) stManager = new STManager();
    });
}

// If the .so is mapped at all, bring HTTP up (doesn't need il2cpp/Paper)
__attribute__((constructor)) static void streamer_tools_ctor() {
    __android_log_print(ANDROID_LOG_INFO, "Streamer-Tools", "so constructor — starting HTTP");
    EnsureServer();
}

static void EnsureInSong() {
    if (stManager->location != 1) {
        stManager->location = 1;
        stManager->goodCuts = 0;
        stManager->badCuts = 0;
        stManager->missedNotes = 0;
        stManager->combo = 0;
        stManager->score = 0;
        stManager->accuracy = 1.0f;
    }
}

MAKE_HOOK_MATCH(SongEnd, &StandardLevelGameplayManager::OnDestroy, void, StandardLevelGameplayManager* self) {
    stManager->statusLock.lock();
    stManager->paused = false;
    stManager->location = 0;
    stManager->statusLock.unlock();
    SongEnd(self);
}

MAKE_HOOK_MATCH(RelativeScoreAndImmediateRankCounter_UpdateRelativeScoreAndImmediateRank,
                &RelativeScoreAndImmediateRankCounter::UpdateRelativeScoreAndImmediateRank, void,
                RelativeScoreAndImmediateRankCounter* self, int score, int modifiedScore, int maxPossibleScore,
                int maxPossibleModifiedScore) {
    RelativeScoreAndImmediateRankCounter_UpdateRelativeScoreAndImmediateRank(self, score, modifiedScore,
                                                                             maxPossibleScore, maxPossibleModifiedScore);
    stManager->statusLock.lock();
    EnsureInSong();
    stManager->score = modifiedScore;
    stManager->accuracy = self->get_relativeScore();
    stManager->statusLock.unlock();
}

MAKE_HOOK_MATCH(GamePause, &PauseController::Pause, void, PauseController* self) {
    stManager->statusLock.lock();
    stManager->paused = true;
    stManager->statusLock.unlock();
    GamePause(self);
}

MAKE_HOOK_MATCH(GameResume, &PauseController::HandlePauseMenuManagerDidPressContinueButton, void,
                PauseController* self) {
    stManager->statusLock.lock();
    stManager->paused = false;
    stManager->statusLock.unlock();
    GameResume(self);
}

MAKE_HOOK_MATCH(ScoreController_HandleNoteWasMissed, &ScoreController::HandleNoteWasMissed, void,
                ScoreController* self, NoteController* note) {
    ScoreController_HandleNoteWasMissed(self, note);
    stManager->statusLock.lock();
    EnsureInSong();
    stManager->missedNotes++;
    stManager->combo = 0;
    stManager->statusLock.unlock();
}

MAKE_HOOK_MATCH(ScoreController_HandleNoteWasCut, &ScoreController::HandleNoteWasCut, void, ScoreController* self,
                NoteController* noteController, ByRef<NoteCutInfo> noteCutInfo) {
    ScoreController_HandleNoteWasCut(self, noteController, noteCutInfo);
    stManager->statusLock.lock();
    EnsureInSong();
    if (noteCutInfo->get_allIsOK()) {
        stManager->goodCuts++;
        stManager->combo++;
    } else {
        stManager->badCuts++;
        stManager->combo = 0;
    }
    stManager->statusLock.unlock();
}

static void InstallHooks() {
    EnsureServer();
    il2cpp_functions::Init();
    PaperLogger.info("Installing hooks...");
    INSTALL_HOOK(PaperLogger, SongEnd);
    INSTALL_HOOK(PaperLogger, RelativeScoreAndImmediateRankCounter_UpdateRelativeScoreAndImmediateRank);
    INSTALL_HOOK(PaperLogger, GamePause);
    INSTALL_HOOK(PaperLogger, GameResume);
    INSTALL_HOOK(PaperLogger, ScoreController_HandleNoteWasMissed);
    INSTALL_HOOK(PaperLogger, ScoreController_HandleNoteWasCut);
    PaperLogger.info("Installed all hooks!");
}

MOD_EXTERN_FUNC void setup(CModInfo* info) noexcept {
    *info = modInfo.to_c();
    EnsureServer();
    Paper::Logger::RegisterFileContextId(PaperLogger.tag);
    PaperLogger.info("Completed setup!");
}

// Early-mod entry (if listed under modFiles)
MOD_EXTERN_FUNC void load() noexcept {
    InstallHooks();
}

// Late-mod entry (lateModFiles)
MOD_EXTERN_FUNC void late_load() noexcept {
    InstallHooks();
}
