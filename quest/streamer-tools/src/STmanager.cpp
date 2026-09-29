#include "STmanager.hpp"
#include "ServerHeaders.hpp"

#include <android/log.h>
#include <cerrno>
#include <cstring>
#include <sstream>
#include <string_view>

#define ST_LOG(...) __android_log_print(ANDROID_LOG_INFO, "Streamer-Tools", __VA_ARGS__)
#define ST_ERR(...) __android_log_print(ANDROID_LOG_ERROR, "Streamer-Tools", __VA_ARGS__)

STManager* stManager = nullptr;

STManager::STManager() {
    // No Paper here — if Paper isn't ready, we still want the socket up for verify
    ST_LOG("Starting HTTP thread on port %d", PORT_HTTP);
    networkThreadHTTP = std::thread(&STManager::runServerHTTP, this);
    networkThreadHTTP.detach();
}

static std::string jsonEscape(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out.push_back('\\');
        if (c == '\n') {
            out += "\\n";
            continue;
        }
        out.push_back(c);
    }
    return out;
}

std::string STManager::constructResponse() {
    std::lock_guard<std::mutex> lock(statusLock);
    std::ostringstream o;
    o << '{'
      << "\"ok\":true,"
      << "\"mod\":\"Streamer-Tools\","
      << "\"version\":\"0.1.2\","
      << "\"location\":" << location << ','
      << "\"paused\":" << (paused ? "true" : "false") << ','
      << "\"score\":" << score << ','
      << "\"combo\":" << combo << ','
      << "\"missedNotes\":" << missedNotes << ','
      << "\"goodCuts\":" << goodCuts << ','
      << "\"badCuts\":" << badCuts << ','
      << "\"accuracy\":" << accuracy << ','
      << "\"energy\":" << energy << ','
      << "\"rank\":\"" << jsonEscape(rank) << "\","
      << "\"levelName\":\"" << jsonEscape(levelName) << "\","
      << "\"songAuthor\":\"" << jsonEscape(songAuthor) << "\""
      << '}';
    return o.str();
}

static std::string ResponseGen(std::string const& httpCode, std::string const& contentType, std::string const& message) {
    return "HTTP/1.1 " + httpCode + "\r\n"
           "Server: Streamer-Tools/0.1.2\r\n"
           "Content-Length: " + std::to_string(message.size()) + "\r\n"
           "Content-Type: " + contentType + "\r\n"
           "Access-Control-Allow-Origin: *\r\n"
           "Connection: close\r\n\r\n" +
           message;
}

bool STManager::runServerHTTP() {
    sockaddr_in server{};
    server.sin_family = AF_INET;
    server.sin_port = htons(PORT_HTTP);
    server.sin_addr.s_addr = htonl(INADDR_ANY);

    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == -1) {
        ST_ERR("HTTP: Error creating socket: %s", strerror(errno));
        return false;
    }
    int iSetOption = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &iSetOption, sizeof(iSetOption));

    if (bind(sock, reinterpret_cast<sockaddr*>(&server), sizeof(server))) {
        ST_ERR("HTTP: Error binding to port %d: %s", PORT_HTTP, strerror(errno));
        close(sock);
        return false;
    }
    if (listen(sock, CONNECTION_QUEUE_LENGTH) == -1) {
        ST_ERR("HTTP: Error listening: %s", strerror(errno));
        close(sock);
        return false;
    }

    ST_LOG("HTTP: Listening on 0.0.0.0:%d", PORT_HTTP);
    while (true) {
        socklen_t len = sizeof(server);
        int client = accept(sock, reinterpret_cast<sockaddr*>(&server), &len);
        if (client == -1) {
            ST_ERR("HTTP: Error accepting: %s", strerror(errno));
            continue;
        }
        std::thread([this, client] { HandleRequestHTTP(client); }).detach();
    }
}

void STManager::ReadRequest(int socketFd, unsigned int x, char* buffer) {
    int bytesRead = 0;
    while (bytesRead < static_cast<int>(x)) {
        int result = read(socketFd, buffer + bytesRead, x - bytesRead);
        if (result < 1) break;
        bytesRead += result;
        std::string_view view(buffer, bytesRead);
        if (view.find("\r\n\r\n") != std::string_view::npos) break;
    }
}

void STManager::SendResponseHTTP(int client_sock, std::string response) {
    if (!response.empty()) {
        if (write(client_sock, response.c_str(), response.length()) == -1) {
            ST_ERR("HTTP: Error sending: %s", strerror(errno));
        }
    }
    close(client_sock);
}

void STManager::HandleRequestHTTP(int client_sock) {
    constexpr unsigned length = 4096;
    char buffer[length + 1]{};
    ReadRequest(client_sock, length, buffer);
    std::string req(buffer);

    if (req.find("GET / ") != std::string::npos || req.find("GET /data") != std::string::npos ||
        req.find("GET /index") != std::string::npos) {
        SendResponseHTTP(client_sock, ResponseGen("200 OK", "application/json", constructResponse()));
        return;
    }

    SendResponseHTTP(client_sock, ResponseGen("404 Not Found", "text/plain", "try GET /data"));
}
