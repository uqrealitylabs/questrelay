#pragma once

#include <mutex>
#include <string>
#include <thread>

// Ported from EnderdracheLP/streamer-tools (GPL-3.0). Verify-phase subset only.
class STManager {
private:
    std::thread networkThreadHTTP;
    bool runServerHTTP();
    void HandleRequestHTTP(int client_sock);
    void ReadRequest(int socket, unsigned int x, char* buffer);
    void SendResponseHTTP(int client_sock, std::string response);
    std::string constructResponse();

public:
    std::mutex statusLock;

    int location = 0; // 0 = Menu, 1 = Solo song (ponytail: only what verify needs)
    bool paused = false;

    int score = 0;
    int combo = 0;
    int missedNotes = 0;
    int goodCuts = 0;
    int badCuts = 0;
    float accuracy = 1.0f;
    float energy = 0.5f;

    std::string levelName;
    std::string songAuthor;
    std::string rank;

    explicit STManager();
};

extern STManager* stManager;
