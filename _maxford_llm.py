"""Клиент HTTP-прокси LLM: MaxfordLLM, ошибки, вызов /chat и /health.

Руководство: MAXFORD_LLM_MANUAL.md и школьная версия MAXFORD_LLM_MANUAL.html в этой папке.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests


class MaxfordLLMError(Exception):
    pass


class MaxfordLLMNetworkError(MaxfordLLMError):
    pass


class MaxfordLLMAPIError(MaxfordLLMError):
    pass


@dataclass
class MaxfordConfig:
    base_url: str
    timeout: int = 180
    connect_timeout: int = 15
    max_retries: int = 4
    retry_delay_sec: float = 0.8
    verify_ssl: bool = True


class MaxfordLLM:
    def __init__(
        self,
        base_url: str,
        token: str,
        system_prompt: Optional[str] = None,
        temperature: float = 0.2,
        model: str = "Lite",
        max_tokens: Optional[int] = None,
        timeout: int = 180,
        connect_timeout: int = 15,
        max_retries: int = 4,
        retry_delay_sec: float = 0.8,
        verify_ssl: bool = True,
    ) -> None:
        self.config = MaxfordConfig(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            connect_timeout=connect_timeout,
            max_retries=max_retries,
            retry_delay_sec=retry_delay_sec,
            verify_ssl=verify_ssl,
        )
        self.token = token.strip()
        self.system_prompt = system_prompt
        self.temperature = float(temperature)
        if not isinstance(model, str) or not model.strip():
            raise ValueError("Выбранная модель не может быть пустой")
        self.model = model.strip()
        self.max_tokens = max_tokens

    def chat(
        self,
        user_prompt: str,
        temperature: Optional[float] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        request_id: Optional[str] = None,
    ) -> str:
        effective_temperature = self.temperature if temperature is None else temperature
        if model is None:
            effective_model = self.model
        else:
            if not isinstance(model, str) or not model.strip():
                raise ValueError("Выбранная модель не может быть пустой")
            effective_model = model.strip()
        effective_system_prompt = self.system_prompt if system_prompt is None else system_prompt
        effective_max_tokens = self.max_tokens if max_tokens is None else max_tokens

        payload: Dict[str, Any] = {
            "token": self.token,
            "user_prompt": user_prompt.strip(),
            "temperature": effective_temperature,
            "model": effective_model,
        }
        if effective_system_prompt is not None:
            payload["system_prompt"] = effective_system_prompt
        if effective_max_tokens is not None:
            payload["max_tokens"] = effective_max_tokens

        headers = {"Content-Type": "application/json"}
        if request_id:
            headers["X-Request-Id"] = request_id

        data = self._post_json("/chat", payload, headers=headers)
        if data.get("ok") != 1:
            raise MaxfordLLMAPIError(data.get("description", "Неизвестная ошибка API"))
        return data.get("data", "")

    def is_online(self) -> bool:
        t = (self.config.connect_timeout, min(self.config.timeout, 60))
        try:
            resp = requests.get(
                f"{self.config.base_url}/health",
                timeout=t,
                verify=self.config.verify_ssl,
                headers={"Connection": "close"},
            )
            return resp.status_code == 200 and resp.json().get("ok") == 1
        except Exception:
            return False

    @staticmethod
    def parse_json_dict(raw_text: str) -> Dict[str, Any]:
        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise MaxfordLLMAPIError("Вывод модели не является валидным JSON") from exc
        if not isinstance(parsed, dict):
            raise MaxfordLLMAPIError("Вывод модели JSON должен быть объектом (dict)")
        return parsed

    def _post_json(
        self,
        path: str,
        payload: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        last_error: Optional[Exception] = None
        url = f"{self.config.base_url}{path}"
        timeout = (self.config.connect_timeout, self.config.timeout)
        merged = dict(headers or {})
        merged.setdefault("Content-Type", "application/json; charset=utf-8")
        merged["Accept"] = "application/json"
        merged["Connection"] = "close"
        merged["User-Agent"] = "maxford_llm/1.0"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        for attempt in range(self.config.max_retries + 1):
            try:
                # Без Session: после RST на стороне прокси пул urllib3 мог держать «битое» соединение.
                resp = requests.post(
                    url,
                    data=body,
                    headers=merged,
                    timeout=timeout,
                    verify=self.config.verify_ssl,
                )
                try:
                    data = resp.json()
                except ValueError:
                    if resp.status_code >= 500 and attempt < self.config.max_retries:
                        time.sleep(self.config.retry_delay_sec)
                        continue
                    resp.raise_for_status()
                    raise MaxfordLLMAPIError("Прокси вернул не JSON-ответ") from None

                if isinstance(data, dict) and data.get("ok") == 0:
                    raise MaxfordLLMAPIError(
                        data.get("description", f"Ошибка API HTTP {resp.status_code}")
                    )

                if resp.status_code >= 400:
                    if resp.status_code >= 500 and attempt < self.config.max_retries:
                        time.sleep(self.config.retry_delay_sec)
                        continue
                    resp.raise_for_status()

                return data
            except MaxfordLLMAPIError:
                raise
            except requests.RequestException as exc:
                last_error = exc
                if attempt >= self.config.max_retries:
                    break
                # После RST / обрыва не спамим одним и тем же интервалом — даём прокси «остыть»
                pause = min(
                    60.0,
                    self.config.retry_delay_sec * (2**attempt),
                )
                time.sleep(pause)
        raise MaxfordLLMNetworkError(
            f"Не удалось достичь ответа после {self.config.max_retries + 1} попыток: {last_error}"
        ) from last_error
