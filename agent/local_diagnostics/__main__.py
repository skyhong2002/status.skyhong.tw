"""Print sanitized local-only JSON; never load status config or run the agent."""
import argparse
import json

from . import diagnostic_report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    # Deliberately no path, endpoint, container, context or config overrides.
    parser.parse_args(argv)
    report, code = diagnostic_report()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
