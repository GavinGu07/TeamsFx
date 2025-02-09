{
  "schema_version": "v2",
  "name_for_human": "{{appName}}${{APP_NAME_SUFFIX}}",
  "description_for_human": "Track your repair records",
  "description_for_model": "Plugin for searching a repair list, you can search by who's assigned to the repair.",
  "functions": [
    {
      "name": "repair",
      "description": "Search for repairs",
      "parameters": {
        "type": "object",
        "properties": {
          "assignedTo": {
            "type": "string",
            "description": "The person assigned to the repair"
          }
        },
        "required": [
          "assignedTo"
      ]
      },
      "states": {
          "reasoning": {
              "description": "Returns the repair records.",
              "instructions": [
                "Here are the parameters:",
                "  assignedTo: The person assigned to the repair."
              ]
          },
          "responding": {
              "description": "Returns the repair result in JSON format.",
              "instructions": "Extract and include as much relevant information as possible from the JSON result to meet the user's needs."
          }
      }
    }    
  ],
  "runtimes": [
    {
      "type": "OpenApi",
      "auth": {
        "type": "none"
      },
      "spec": {
        "url": "apiSpecificationFile/repair.yml",
        "progress_style": "ShowUsageWithInputAndOutput"
      },
      "run_for_functions": ["repair"]
    }
  ]
}
